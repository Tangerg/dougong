import type { ExtensionPoint } from "./contracts";
import { ReadonlyMapSnapshot } from "./readonly-map";
import type { Disposable, Publication, StagedResource } from "./resource";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export interface Contribution<T> extends Disposable {
  update(value: T): void;
}

export type ContributionView<T> = SnapshotView<ReadonlyMap<string, T>>;

export type ContributionLeaseKind = "view" | "subscription";

interface ContributionViewBinding<T> {
  readonly store: ContributionStore<T>;
  readonly own: (resource: Disposable, kind: ContributionLeaseKind) => () => void;
}

interface ContributionViewState<T> {
  binding: ContributionViewBinding<T> | undefined;
}

class ContributionViewHandle<T> implements ContributionView<T> {
  readonly #state: ContributionViewState<T>;
  readonly get: () => ReadonlyMap<string, T>;
  readonly subscribe: (listener: () => void) => Disposable;

  constructor(state: ContributionViewState<T>) {
    this.#state = state;
    this.get = () => this.#read();
    this.subscribe = (listener) => this.#subscribe(listener);
    Object.freeze(this);
  }

  // The handle retains only revocable binding state. Disposing its lease clears
  // the ContributionStore edge even when downstream code retains the public view.
  #read() {
    const binding = this.#requireBinding();
    return binding.store.snapshot();
  }

  #subscribe(listener: () => void) {
    const binding = this.#requireBinding();
    return binding.store.subscribe(listener, binding.own);
  }

  #requireBinding() {
    const binding = this.#state.binding;
    if (!binding) throw new TypeError("Contribution view has been disposed");
    return binding;
  }
}

type ContributionState<T> =
  | {
      phase: "staged" | "published";
      readonly store: ContributionStore<T>;
      value: T;
      readonly detachFromOwner: (publication: Publication) => void;
    }
  | { readonly phase: "disposed" };

class ContributionHandle<T> implements Contribution<T> {
  readonly #contribution: ContributionRecord<T>;

  constructor(contribution: ContributionRecord<T>) {
    this.#contribution = contribution;
    Object.freeze(this);
  }

  update(value: T) {
    this.#contribution.update(value);
  }

  dispose() {
    this.#contribution.dispose();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

class ContributionRecord<T> implements StagedResource<Contribution<T>> {
  #state: ContributionState<T>;
  readonly #id: string;
  readonly handle: Contribution<T>;

  constructor(
    store: ContributionStore<T>,
    id: string,
    initialValue: T,
    detachFromOwner: (publication: Publication) => void,
  ) {
    this.#id = id;
    this.#state = { phase: "staged", store, value: initialValue, detachFromOwner };
    this.handle = new ContributionHandle(this);
  }

  publish() {
    const state = this.#state;
    if (state.phase !== "staged") return;
    state.store.insert(this.#id, this, state.value);
  }

  commitPublication() {
    const state = this.#state;
    if (state.phase !== "staged") {
      throw new Error(`Contribution '${this.#id}' is not staged`);
    }
    state.phase = "published";
  }

  update(value: T) {
    const state = this.#state;
    if (state.phase === "disposed") {
      throw new TypeError(`Contribution '${this.#id}' has been disposed`);
    }
    if (Object.is(state.value, value)) return;
    state.value = value;
    if (state.phase === "published") state.store.update(this.#id, this, value);
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposed") return;
    this.#state = { phase: "disposed" };
    try {
      state.store.removeContribution(this.#id, this, state.phase);
    } finally {
      state.detachFromOwner(this);
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ContributionStore<T> {
  readonly #invalidate: (store: ContributionStore<unknown>) => void;
  readonly #releaseIfUnused: (store: ContributionStore<unknown>) => void;
  readonly #claims = new Map<string, ContributionRecord<T>>();
  readonly #entries = new Map<string, { contribution: ContributionRecord<T>; value: T }>();
  readonly #publisher: SnapshotPublisher<ReadonlyMap<string, T>>;
  #snapshot: ReadonlyMap<string, T> = new ReadonlyMapSnapshot();
  #views = 0;
  #subscriptions = 0;
  #released = false;

  constructor(
    invalidate: (store: ContributionStore<unknown>) => void,
    report: (error: unknown) => void,
    releaseIfUnused: (store: ContributionStore<unknown>) => void,
  ) {
    this.#invalidate = invalidate;
    this.#releaseIfUnused = releaseIfUnused;
    this.#publisher = new SnapshotPublisher(() => this.#snapshot, report);
  }

  stage(
    ownerId: string,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ): ContributionRecord<T> {
    validateKey(key);
    const id = contributionId(ownerId, key);
    if (this.#claims.has(id)) {
      throw new TypeError(`Duplicate contribution '${id}'`);
    }
    const contribution = new ContributionRecord(this, id, value, release);
    this.#claims.set(id, contribution);
    return contribution;
  }

  view(
    own: (resource: Disposable, kind: ContributionLeaseKind) => () => void,
  ): ContributionView<T> {
    this.#views++;
    const state: ContributionViewState<T> = { binding: { store: this, own } };
    let releaseView: (() => void) | undefined;
    const lease = new ContributionViewLease(state, () => {
      const release = releaseView;
      releaseView = undefined;
      try {
        release?.();
      } finally {
        this.#views--;
        this.#notifyIfUnused();
      }
    });
    try {
      releaseView = own(lease, "view");
    } catch (error) {
      state.binding = undefined;
      this.#views--;
      this.#notifyIfUnused();
      throw error;
    }
    return new ContributionViewHandle(state);
  }

  snapshot() {
    return this.#publisher.view.get();
  }

  subscribe(
    listener: () => void,
    own: (resource: Disposable, kind: ContributionLeaseKind) => () => void,
  ) {
    if (typeof listener !== "function") {
      throw new TypeError("Contribution subscriber must be a function");
    }
    const publisherSubscription = this.#publisher.view.subscribe(listener);
    this.#subscriptions++;
    let releaseFromOwner: (() => void) | undefined;
    const subscription = new ContributionSubscription(publisherSubscription, () => {
      const release = releaseFromOwner;
      releaseFromOwner = undefined;
      try {
        release?.();
      } finally {
        this.#subscriptions--;
        this.#notifyIfUnused();
      }
    });
    try {
      releaseFromOwner = own(subscription, "subscription");
    } catch (error) {
      subscription.dispose();
      throw error;
    }
    return subscription;
  }

  insert(id: string, contribution: ContributionRecord<T>, value: T) {
    this.#assertCurrentClaim(id, contribution);
    if (this.#entries.has(id)) {
      throw new Error(`Contribution '${id}' is already published`);
    }
    contribution.commitPublication();
    this.#entries.set(id, { contribution, value });
    this.#invalidate(this as ContributionStore<unknown>);
  }

  update(id: string, contribution: ContributionRecord<T>, value: T) {
    const entry = this.#requirePublishedEntry(id, contribution);
    entry.value = value;
    this.#invalidate(this as ContributionStore<unknown>);
  }

  removeContribution(
    id: string,
    contribution: ContributionRecord<T>,
    visibility: "staged" | "published",
  ) {
    this.#assertCurrentClaim(id, contribution);
    if (visibility === "published") this.#requirePublishedEntry(id, contribution);

    try {
      this.#claims.delete(id);
      if (visibility === "published") {
        this.#entries.delete(id);
        this.#invalidate(this as ContributionStore<unknown>);
      }
    } finally {
      this.#notifyIfUnused();
    }
  }

  publishSnapshot() {
    const nextEntries = [...this.#entries].map(([key, entry]) => [key, entry.value] as const);
    const unchanged =
      nextEntries.length === this.#snapshot.size &&
      nextEntries.every(([key, value]) => Object.is(this.#snapshot.get(key), value));
    if (unchanged) return;

    this.#snapshot = new ReadonlyMapSnapshot(nextEntries);
    this.#publisher.invalidate();
  }

  #assertCurrentClaim(id: string, contribution: ContributionRecord<T>) {
    if (this.#claims.get(id) !== contribution) {
      throw new Error(`Contribution '${id}' is not the current claim`);
    }
  }

  #requirePublishedEntry(id: string, contribution: ContributionRecord<T>) {
    const entry = this.#entries.get(id);
    if (entry?.contribution !== contribution) {
      throw new Error(`Contribution '${id}' is not the published entry`);
    }
    return entry;
  }

  #notifyIfUnused() {
    if (
      this.#released ||
      this.#claims.size ||
      this.#entries.size ||
      this.#subscriptions ||
      this.#views
    ) {
      return;
    }
    this.#released = true;
    try {
      this.#publisher.dispose();
    } finally {
      this.#releaseIfUnused(this as ContributionStore<unknown>);
    }
  }
}

class ContributionViewLease<T> implements Disposable {
  #binding:
    | {
        readonly state: ContributionViewState<T>;
        readonly release: () => void;
      }
    | undefined;

  constructor(state: ContributionViewState<T>, release: () => void) {
    this.#binding = { state, release };
    Object.freeze(this);
  }

  dispose() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    binding.state.binding = undefined;
    binding.release();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

class ContributionSubscription implements Disposable {
  #binding:
    | {
        readonly subscription: Disposable;
        readonly release: () => void;
      }
    | undefined;

  constructor(subscription: Disposable, release: () => void) {
    this.#binding = { subscription, release };
    Object.freeze(this);
  }

  dispose() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    try {
      binding.subscription.dispose();
    } finally {
      binding.release();
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ContributionRegistry {
  readonly #stores = new Map<string, ContributionStore<unknown>>();
  readonly #invalidated = new Set<ContributionStore<unknown>>();
  readonly #report: (error: unknown) => void;
  #batchDepth = 0;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  get<T>(token: ExtensionPoint<T>): ContributionStore<T> {
    const current = this.#stores.get(token.id);
    if (current) return current as ContributionStore<T>;
    const store = new ContributionStore<T>(
      (item) => this.#invalidate(item),
      this.#report,
      (item) => {
        if (this.#stores.get(token.id) !== item) return;
        this.#invalidated.delete(item);
        this.#stores.delete(token.id);
      },
    );
    this.#stores.set(token.id, store as ContributionStore<unknown>);
    return store;
  }

  beginBatch() {
    this.#batchDepth++;
  }

  endBatch() {
    if (!this.#batchDepth) throw new Error("Contribution batch is not active");
    this.#batchDepth--;
    if (this.#batchDepth) return;
    const stores = [...this.#invalidated];
    this.#invalidated.clear();
    const errors: unknown[] = [];
    for (const store of stores) {
      try {
        store.publishSnapshot();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Contribution batch publication failed");
    }
  }

  #invalidate(store: ContributionStore<unknown>) {
    this.#invalidated.add(store);
    if (this.#batchDepth) return;
    this.#invalidated.delete(store);
    store.publishSnapshot();
  }
}

function validateKey(key: string) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Contribution key must be a non-empty string");
  }
  if (key !== key.trim()) {
    throw new TypeError("Contribution key cannot start or end with whitespace");
  }
}

function contributionId(ownerId: string, key: string) {
  return `${escapeKeyPart(ownerId)}/${escapeKeyPart(key)}`;
}

function escapeKeyPart(value: string) {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}
