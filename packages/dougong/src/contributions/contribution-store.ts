// A store stays reachable while claims, views or subscriptions can still use it.

import {
  normalizeContract,
  type ContractIdentity,
  type ExtensionPoint,
  type Requirement,
} from "../contracts/contracts.js";
import {
  DougongError,
  contributionUnavailableCode,
  lifetimeDisposedCode,
} from "../contracts/errors.js";
import type { Lifetime, LifetimeOwnership } from "../lifetime/lifetime.js";
import type { ResolvedValue } from "../internal/async-result.js";
import {
  disposeSymbol,
  markOwnedControlHandle,
  type Disposable,
  type Publication,
  type Awaitable,
} from "../contracts/resource.js";
import {
  batchSnapshotNotifications,
  SnapshotPublisher,
  type SnapshotView,
} from "../observation/snapshot-view.js";

export interface Contribution<T> extends Disposable {
  readonly update: (value: T) => void;
}

export interface ContributionView<T> extends SnapshotView<ReadonlyArray<string>> {
  use<Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>>;
}

export interface ContributionOperations {
  add<T>(
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    options?: LifetimeOwnership,
  ): Contribution<T>;
}

type ExtensionPointIdentity = Extract<Requirement, { readonly kind: "extensionPoint" }>;

interface ContributionViewBinding<T> {
  readonly store: ContributionStore<T>;
  readonly own?: (resource: Disposable) => () => void;
  readonly owner?: Lifetime;
}

interface ContributionViewState<T> {
  binding: ContributionViewBinding<T> | undefined;
}

class ContributionViewHandle<T> implements ContributionView<T> {
  readonly #state: ContributionViewState<T>;
  readonly get: () => ReadonlyArray<string>;
  readonly subscribe: SnapshotView<ReadonlyArray<string>>["subscribe"];
  readonly use: <Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ) => Promise<ResolvedValue<Awaited<Result>>>;

  constructor(state: ContributionViewState<T>) {
    this.#state = state;
    this.get = () => this.#read();
    this.subscribe = (listener) => this.#subscribe(listener);
    this.use = (id, callback) => {
      try {
        return this.#requireBinding().store.use(id, callback);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    Object.freeze(this);
  }

  // Revocable bindings prevent a retained view from keeping its disposed store alive.
  #read() {
    const binding = this.#requireBinding();
    return binding.store.snapshot();
  }

  #subscribe(listener: () => void) {
    const binding = this.#requireBinding();
    if (typeof listener !== "function")
      throw new TypeError("Contribution subscriber must be a function");
    return binding.store.subscribe(() => {
      if (binding.owner && !binding.owner.acceptsWork) return;
      return listener();
    }, binding.own);
  }

  #requireBinding() {
    const binding = this.#state.binding;
    if (!binding)
      throw new DougongError(lifetimeDisposedCode, "Contribution view has been disposed");
    if (binding.owner && !binding.owner.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Contribution view owner is closed");
    }
    return binding;
  }
}

type ContributionState<T> =
  | {
      readonly phase: "active";
      readonly store: ContributionStore<T>;
      value: T;
      readonly detachFromOwner: () => void;
      readonly owner: Lifetime;
    }
  | { readonly phase: "disposed" };

class ContributionHandle<T> implements Contribution<T> {
  readonly #contribution: ContributionRecord<T>;

  constructor(contribution: ContributionRecord<T>) {
    this.#contribution = contribution;
    Object.freeze(this);
  }

  readonly update = (value: T) => this.#contribution.update(value);

  [disposeSymbol]() {
    this.#contribution[disposeSymbol]();
  }
}

class ContributionRecord<T> implements Publication {
  #state: ContributionState<T>;
  readonly #id: string;
  readonly handle: Contribution<T>;

  constructor(
    store: ContributionStore<T>,
    id: string,
    initialValue: T,
    owner: Lifetime,
    detachFromOwner: () => void,
  ) {
    this.#id = id;
    this.#state = { phase: "active", store, value: initialValue, owner, detachFromOwner };
    this.handle = markOwnedControlHandle(new ContributionHandle(this));
  }

  publish() {
    const state = this.#state;
    if (state.phase === "disposed") return;
    state.store.publishClaim(this.#id, this);
  }

  use<Result>(callback: (value: T) => Awaitable<Result>): Promise<ResolvedValue<Awaited<Result>>> {
    const state = this.#state;
    if (state.phase === "disposed")
      throw new DougongError(contributionUnavailableCode, "Contribution is no longer available");
    const { owner, value } = state;
    return owner.borrow(() => callback(value));
  }

  update(value: T) {
    const state = this.#state;
    if (state.phase === "disposed") {
      throw new TypeError(`Contribution '${this.#id}' has been disposed`);
    }
    if (!state.owner.acceptsWork)
      throw new DougongError(lifetimeDisposedCode, "Contribution owner is closed");
    if (Object.is(state.value, value)) return;
    state.value = value;
    state.store.valueChanged(this.#id, this);
  }

  [disposeSymbol]() {
    const state = this.#state;
    if (state.phase === "disposed") return;
    this.#state = { phase: "disposed" };
    batchSnapshotNotifications(() => {
      try {
        state.store.removeContribution(this.#id, this);
      } finally {
        state.detachFromOwner();
      }
    });
  }
}

export class ContributionStore<T> {
  readonly #invalidate: (store: ContributionStore<unknown>) => void;
  readonly #releaseIfUnused: (store: ContributionStore<unknown>) => void;
  readonly #claims = new Map<
    string,
    { readonly contribution: ContributionRecord<T>; phase: "staged" | "pending" | "published" }
  >();
  readonly #publisher: SnapshotPublisher<ReadonlyArray<string>>;
  #snapshot: ReadonlyArray<string> = Object.freeze([]);
  #views = 0;
  #subscriptions = 0;
  #hostView: ContributionView<T> | undefined;
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
    installationId: string,
    key: string,
    value: T,
    owner: Lifetime,
    remember?: () => void,
  ): Contribution<T> {
    // A failed claim can create a zero-reference store without a lease to release it.
    try {
      validateKey(key);
      const id = contributionId(installationId, key);
      if (this.#claims.has(id)) {
        throw new TypeError(`Duplicate contribution '${id}'`);
      }
      return owner.stage((detach) => {
        remember?.();
        const contribution = new ContributionRecord(this, id, value, owner, detach);
        this.#claims.set(id, { contribution, phase: "staged" });
        return contribution;
      }).handle;
    } catch (error) {
      this.#notifyIfUnused();
      throw error;
    }
  }

  view(own: (resource: Disposable) => () => void, owner?: Lifetime): ContributionView<T> {
    this.#views++;
    const state: ContributionViewState<T> = {
      binding: { store: this, own, ...(owner && { owner }) },
    };
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
      releaseView = own(lease);
    } catch (error) {
      state.binding = undefined;
      this.#views--;
      this.#notifyIfUnused();
      throw error;
    }
    return new ContributionViewHandle(state);
  }

  // Host-owned views pin the store because application code has no Lifetime from which to lease one.
  hostView(): ContributionView<T> {
    return (this.#hostView ??= new ContributionViewHandle<T>({ binding: { store: this } }));
  }

  use<Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>> {
    const claim = this.#claims.get(id);
    if (claim?.phase !== "published")
      throw new DougongError(contributionUnavailableCode, `Contribution '${id}' is not available`);
    if (typeof callback !== "function")
      throw new TypeError("Contribution callback must be a function");
    return claim.contribution.use(callback);
  }

  snapshot() {
    return this.#publisher.view.get();
  }

  subscribe(listener: () => void, own?: (resource: Disposable) => () => void) {
    if (typeof listener !== "function") {
      throw new TypeError("Contribution subscriber must be a function");
    }
    const publisherSubscription = this.#publisher.view.subscribe(listener);
    if (!own) return publisherSubscription;
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
      releaseFromOwner = own(subscription);
      markOwnedControlHandle(subscription);
    } catch (error) {
      subscription[disposeSymbol]();
      throw error;
    }
    return subscription;
  }

  publishClaim(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);
    if (claim.phase !== "staged") return;
    claim.phase = "pending";
    this.#claims.delete(id);
    this.#claims.set(id, claim);
    this.#invalidate(this as ContributionStore<unknown>);
  }

  valueChanged(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);
    if (claim.phase === "staged") return;
    claim.phase = "pending";
    this.#invalidate(this as ContributionStore<unknown>);
  }

  removeContribution(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);

    try {
      this.#claims.delete(id);
      if (claim.phase !== "staged") {
        this.#invalidate(this as ContributionStore<unknown>);
      }
    } finally {
      this.#notifyIfUnused();
    }
  }

  publishSnapshot() {
    const ids: string[] = [];
    let changed = false;
    for (const [id, claim] of this.#claims) {
      if (claim.phase === "staged") continue;
      if (claim.phase === "pending" || this.#snapshot[ids.length] !== id) changed = true;
      ids.push(id);
      claim.phase = "published";
    }
    if (!changed && ids.length === this.#snapshot.length) return;
    // A snapshot may outlive the generation. Only the store lends its executable values.
    this.#snapshot = Object.freeze(ids);
    this.#publisher.invalidate();
  }

  #requireClaim(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#claims.get(id);
    if (claim?.contribution !== contribution) {
      throw new Error(`Contribution '${id}' is not the current claim`);
    }
    return claim;
  }

  // Seal release before disposing the publisher because disposal can reenter the release check.
  #notifyIfUnused() {
    if (
      this.#released ||
      this.#hostView ||
      this.#claims.size ||
      this.#subscriptions ||
      this.#views
    ) {
      return;
    }
    this.#released = true;
    try {
      this.#publisher[disposeSymbol]();
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

  [disposeSymbol]() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    binding.state.binding = undefined;
    binding.release();
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

  [disposeSymbol]() {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    try {
      binding.subscription[disposeSymbol]();
    } finally {
      binding.release();
    }
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

  get<T = unknown>(token: ExtensionPointIdentity): ContributionStore<T> {
    const id = token.id;
    const current = this.#stores.get(id);
    if (current) return current as ContributionStore<T>;
    const store = new ContributionStore<T>(
      (item) => this.#invalidate(item),
      this.#report,
      (item) => {
        if (this.#stores.get(id) !== item) return;
        this.#invalidated.delete(item);
        this.#stores.delete(id);
      },
    );
    this.#stores.set(id, store as ContributionStore<unknown>);
    return store;
  }

  view<T = unknown>(token: ExtensionPointIdentity, owner?: Lifetime): ContributionView<T> {
    const store = this.get<T>(token);
    return owner ? store.view((resource) => owner.own(resource), owner) : store.hostView();
  }

  scope(
    owner: Lifetime,
    installationId: string,
    remember: (token: ContractIdentity) => void,
  ): ContributionOperations {
    return new ContributionScope(this, owner, installationId, remember);
  }

  beginBatch() {
    this.#batchDepth++;
  }

  // Attempt every publication so one broken store cannot strand the others with stale snapshots.
  endBatch() {
    if (!this.#batchDepth) throw new Error("Contribution batch is not active");
    this.#batchDepth--;
    if (this.#batchDepth) return;
    const stores = [...this.#invalidated];
    this.#invalidated.clear();
    batchSnapshotNotifications(() => {
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
    });
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

function contributionId(installationId: string, key: string) {
  return `${escapeKeyPart(installationId)}/${escapeKeyPart(key)}`;
}

// Escaping prevents different Installation/key pairs from producing the same contribution id.
function escapeKeyPart(value: string) {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

class ContributionScope implements ContributionOperations {
  #binding:
    | {
        readonly registry: ContributionRegistry;
        readonly owner: Lifetime;
        readonly installationId: string;
        readonly remember: (token: ContractIdentity) => void;
      }
    | undefined;

  constructor(
    registry: ContributionRegistry,
    owner: Lifetime,
    installationId: string,
    remember: (token: ContractIdentity) => void,
  ) {
    this.#binding = { registry, owner, installationId, remember };
    owner.defer(() => {
      this.#binding = undefined;
    });
    Object.freeze(this);
  }

  add<T>(
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    options?: LifetimeOwnership,
  ): Contribution<T> {
    const binding = this.#binding;
    if (!binding || !binding.owner.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Contribution scope is closed");
    }
    const identity = normalizeContract(token, "extensionPoint");
    const owner = binding.owner.resolveOwner(options);
    return binding.registry
      .get<T>(identity)
      .stage(binding.installationId, key, value, owner, () => binding.remember(identity));
  }
}
