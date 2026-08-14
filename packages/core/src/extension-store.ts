import type { Extension } from "./contracts";
import { ReadonlyMapSnapshot } from "./readonly-map";
import type { Disposable, Publication, StagedResource } from "./resource";
import type { SnapshotView } from "./snapshot-view";

export interface Contribution<T> extends Disposable {
  update(value: T): void;
}

export type ExtensionView<T> = SnapshotView<ReadonlyMap<string, T>>;

export type ExtensionLeaseKind = "view" | "subscription";

interface ExtensionViewBinding<T> {
  readonly store: ExtensionStore<T>;
  readonly own: (resource: Disposable, kind: ExtensionLeaseKind) => () => void;
}

interface ExtensionViewState<T> {
  binding: ExtensionViewBinding<T> | undefined;
}

class ExtensionViewHandle<T> implements ExtensionView<T> {
  readonly #state: ExtensionViewState<T>;
  readonly get: () => ReadonlyMap<string, T>;
  readonly subscribe: (listener: () => void) => Disposable;

  constructor(state: ExtensionViewState<T>) {
    this.#state = state;
    this.get = () => this.#read();
    this.subscribe = (listener) => this.#subscribe(listener);
    Object.freeze(this);
  }

  // The handle retains only revocable binding state. Disposing its lease clears
  // the Store edge even when downstream code retains the public view.
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
    if (!binding) throw new TypeError("Extension view has been disposed");
    return binding;
  }
}

type ContributionState<T> =
  | {
      phase: "staged" | "published";
      readonly store: ExtensionStore<T>;
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
    store: ExtensionStore<T>,
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

export class ExtensionStore<T> {
  readonly #invalidate: (store: ExtensionStore<unknown>) => void;
  readonly #report: (error: unknown) => void;
  readonly #releaseIfUnused: (store: ExtensionStore<unknown>) => void;
  readonly #claims = new Map<string, ContributionRecord<T>>();
  readonly #entries = new Map<string, { contribution: ContributionRecord<T>; value: T }>();
  readonly #listeners = new Set<() => void>();
  #snapshot: ReadonlyMap<string, T> = new ReadonlyMapSnapshot();
  #views = 0;

  constructor(
    invalidate: (store: ExtensionStore<unknown>) => void,
    report: (error: unknown) => void,
    releaseIfUnused: (store: ExtensionStore<unknown>) => void,
  ) {
    this.#invalidate = invalidate;
    this.#report = report;
    this.#releaseIfUnused = releaseIfUnused;
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
      throw new TypeError(`Duplicate extension contribution '${id}'`);
    }
    const contribution = new ContributionRecord(this, id, value, release);
    this.#claims.set(id, contribution);
    return contribution;
  }

  view(own: (resource: Disposable, kind: ExtensionLeaseKind) => () => void): ExtensionView<T> {
    this.#views++;
    const state: ExtensionViewState<T> = { binding: { store: this, own } };
    let releaseView: (() => void) | undefined;
    const lease = new ExtensionViewLease(state, () => {
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
    return new ExtensionViewHandle(state);
  }

  snapshot() {
    return this.#snapshot;
  }

  subscribe(
    listener: () => void,
    own: (resource: Disposable, kind: ExtensionLeaseKind) => () => void,
  ) {
    if (typeof listener !== "function") {
      throw new TypeError("Extension subscriber must be a function");
    }
    let releaseFromOwner: (() => void) | undefined;
    const subscription = new ExtensionSubscription(this, listener, () => {
      const release = releaseFromOwner;
      releaseFromOwner = undefined;
      release?.();
    });
    releaseFromOwner = own(subscription, "subscription");
    this.#listeners.add(listener);
    return subscription;
  }

  insert(id: string, contribution: ContributionRecord<T>, value: T) {
    if (this.#claims.get(id) !== contribution) {
      throw new Error(`Extension contribution '${id}' is not the current claim`);
    }
    if (this.#entries.has(id)) {
      throw new Error(`Extension contribution '${id}' is already published`);
    }
    this.#entries.set(id, { contribution, value });
    this.#invalidate(this as ExtensionStore<unknown>);
  }

  update(id: string, contribution: ContributionRecord<T>, value: T) {
    const entry = this.#entries.get(id);
    if (entry?.contribution !== contribution) return;
    entry.value = value;
    this.#invalidate(this as ExtensionStore<unknown>);
  }

  removeContribution(
    id: string,
    contribution: ContributionRecord<T>,
    visibility: "staged" | "published",
  ) {
    if (this.#claims.get(id) === contribution) this.#claims.delete(id);
    if (visibility === "published" && this.#entries.get(id)?.contribution === contribution) {
      this.#entries.delete(id);
      this.#invalidate(this as ExtensionStore<unknown>);
    }
    this.#notifyIfUnused();
  }

  publishSnapshot() {
    const nextEntries = [...this.#entries].map(([key, entry]) => [key, entry.value] as const);
    const unchanged =
      nextEntries.length === this.#snapshot.size &&
      nextEntries.every(([key, value]) => Object.is(this.#snapshot.get(key), value));
    if (unchanged) return;

    this.#snapshot = new ReadonlyMapSnapshot(nextEntries);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#report(error);
      }
    }
  }

  removeListener(listener: () => void) {
    this.#listeners.delete(listener);
    this.#notifyIfUnused();
  }

  #notifyIfUnused() {
    if (this.#claims.size || this.#entries.size || this.#listeners.size || this.#views) return;
    this.#releaseIfUnused(this as ExtensionStore<unknown>);
  }
}

class ExtensionViewLease<T> implements Disposable {
  #binding:
    | {
        readonly state: ExtensionViewState<T>;
        readonly release: () => void;
      }
    | undefined;

  constructor(state: ExtensionViewState<T>, release: () => void) {
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

class ExtensionSubscription<T> implements Disposable {
  #binding:
    | {
        readonly store: ExtensionStore<T>;
        readonly listener: () => void;
        readonly release: () => void;
      }
    | undefined;

  constructor(store: ExtensionStore<T>, listener: () => void, release: () => void) {
    this.#binding = { store, listener, release };
    Object.freeze(this);
  }

  dispose() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    try {
      binding.store.removeListener(binding.listener);
    } finally {
      binding.release();
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ExtensionRegistry {
  readonly #stores = new Map<string, ExtensionStore<unknown>>();
  readonly #invalidated = new Set<ExtensionStore<unknown>>();
  readonly #report: (error: unknown) => void;
  #batchDepth = 0;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  get<T>(token: Extension<T>): ExtensionStore<T> {
    const current = this.#stores.get(token.id);
    if (current) return current as ExtensionStore<T>;
    const store = new ExtensionStore<T>(
      (item) => this.#invalidate(item),
      this.#report,
      (item) => {
        if (this.#stores.get(token.id) !== item) return;
        this.#invalidated.delete(item);
        this.#stores.delete(token.id);
      },
    );
    this.#stores.set(token.id, store as ExtensionStore<unknown>);
    return store;
  }

  beginBatch() {
    this.#batchDepth++;
  }

  endBatch() {
    if (!this.#batchDepth) throw new TypeError("Extension batch is not active");
    this.#batchDepth--;
    if (this.#batchDepth) return;
    const stores = [...this.#invalidated];
    this.#invalidated.clear();
    for (const store of stores) store.publishSnapshot();
  }

  #invalidate(store: ExtensionStore<unknown>) {
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

export type ExtensionRequirementView<T> =
  T extends Extension<infer Value> ? ExtensionView<Value> : never;
