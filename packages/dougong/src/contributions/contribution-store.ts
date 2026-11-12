// A store stays reachable while claims, views or subscriptions can still use it.

import {
  DougongError,
  contributionUnavailableCode,
  lifetimeDisposedCode,
} from "../contracts/errors.js";
import type { Lifetime } from "../lifetime/lifetime.js";
import type { ResolvedValue } from "../internal/async-result.js";
import {
  disposeSymbol,
  type Disposable,
  type Publication,
  type Awaitable,
} from "../contracts/resource.js";
import { batchSnapshotNotifications, SnapshotPublisher } from "../observation/snapshot-view.js";
import {
  ContributionViewHandle,
  type ContributionSource,
  type ContributionView,
  type ContributionViewState,
} from "./contribution-view.js";

export interface Contribution<T> extends Disposable {
  readonly update: (value: T) => void;
}

interface StoreCallbacks {
  readonly invalidate: (store: ContributionStore<unknown>) => void;
  readonly release: (store: ContributionStore<unknown>) => void;
}

type ContributionState<T> =
  | {
      readonly phase: "active";
      readonly store: ContributionStore<T>;
      value: T;
      readonly owner: Lifetime;
    }
  | { readonly phase: "disposed" };

class ContributionHandle<T> implements Contribution<T> {
  readonly #contribution: ContributionRecord<T>;
  readonly #withdraw: () => void;

  constructor(contribution: ContributionRecord<T>, withdraw: () => void) {
    this.#contribution = contribution;
    this.#withdraw = withdraw;
    Object.freeze(this);
  }

  readonly update = (value: T) => this.#contribution.update(value);

  [disposeSymbol]() {
    this.#withdraw();
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
    withdraw: () => void,
  ) {
    this.#id = id;
    this.#state = { phase: "active", store, value: initialValue, owner };
    this.handle = new ContributionHandle(this, withdraw);
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
    state.store.removeContribution(this.#id, this);
  }
}

// A staged claim is invisible; pending marks a published claim whose snapshot entry is stale.
type ClaimPhase = "staged" | "pending" | "published";

export class ContributionStore<T> implements ContributionSource<T> {
  readonly #callbacks: StoreCallbacks;
  #report: ((error: unknown) => void) | undefined;
  readonly #claims = new Map<
    string,
    { readonly contribution: ContributionRecord<T>; phase: ClaimPhase }
  >();
  readonly #publisher: SnapshotPublisher<ReadonlyArray<string>>;
  #snapshot: ReadonlyArray<string> = Object.freeze([]);
  #views = 0;
  #subscriptions = 0;
  #hostView:
    { readonly view: ContributionView<T>; readonly state: ContributionViewState<T> } | undefined;
  #released = false;

  constructor(callbacks: StoreCallbacks, report: (error: unknown) => void) {
    this.#callbacks = callbacks;
    this.#report = report;
    this.#publisher = new SnapshotPublisher(() => this.#snapshot, report);
  }

  stage(id: string, value: T, owner: Lifetime, remember: () => void): Contribution<T> {
    // A failed claim can create a zero-reference store without a cleanup to release it.
    try {
      if (this.#claims.has(id)) throw new TypeError(`Duplicate contribution '${id}'`);
      return owner.stage((withdraw) => {
        remember();
        const contribution = new ContributionRecord(this, id, value, owner, withdraw);
        this.#claims.set(id, { contribution, phase: "staged" });
        return contribution;
      });
    } catch (error) {
      this.#releaseIfUnused();
      throw error;
    }
  }

  view(owner: Lifetime): ContributionView<T> {
    const state: ContributionViewState<T> = {
      binding: { phase: "active", source: this, owner },
    };
    owner.registerSynchronousCleanup(() => {
      this.#views++;
      return () => {
        state.binding = undefined;
        this.#views--;
        this.#releaseIfUnused();
      };
    });
    return new ContributionViewHandle(state);
  }

  // Host-owned views pin the store because application code has no Lifetime from which to lease one.
  hostView(): ContributionView<T> {
    if (!this.#hostView) {
      const state: ContributionViewState<T> = { binding: { phase: "active", source: this } };
      this.#hostView = { state, view: new ContributionViewHandle(state) };
    }
    return this.#hostView.view;
  }

  sealHostView() {
    const current = this.#hostView;
    if (!current) return;
    this.#hostView = undefined;
    current.state.binding = { phase: "sealed", snapshot: this.#snapshot };
    this.#releaseIfUnused();
  }

  use<Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>> {
    const claim = this.#claims.get(id);
    if (claim?.phase !== "published")
      throw new DougongError(contributionUnavailableCode, `Contribution '${id}' is not available`);
    return claim.contribution.use(callback);
  }

  snapshot() {
    return this.#publisher.view.get();
  }

  subscribe(listener: () => void, owner?: Lifetime) {
    if (!owner) return this.#publisher.view.subscribe(listener);
    return owner.registerSynchronousCleanup(() => {
      const subscription = this.#publisher.view.subscribe(listener);
      this.#subscriptions++;
      return () => {
        try {
          subscription[disposeSymbol]();
        } finally {
          this.#subscriptions--;
          this.#releaseIfUnused();
        }
      };
    });
  }

  publishClaim(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);
    if (claim.phase !== "staged") return;
    claim.phase = "pending";
    // Publication order is snapshot order, so a newly published claim moves behind earlier ones.
    this.#claims.delete(id);
    this.#claims.set(id, claim);
    this.#callbacks.invalidate(this as ContributionStore<unknown>);
  }

  valueChanged(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);
    if (claim.phase === "staged") return;
    claim.phase = "pending";
    this.#callbacks.invalidate(this as ContributionStore<unknown>);
  }

  removeContribution(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#requireClaim(id, contribution);
    try {
      this.#claims.delete(id);
      if (claim.phase !== "staged") this.#callbacks.invalidate(this as ContributionStore<unknown>);
    } finally {
      this.#releaseIfUnused();
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
    batchSnapshotNotifications(() => this.#publisher.invalidate(), this.#report);
  }

  #requireClaim(id: string, contribution: ContributionRecord<T>) {
    const claim = this.#claims.get(id);
    if (claim?.contribution !== contribution) {
      throw new Error(`Contribution '${id}' is not the current claim`);
    }
    return claim;
  }

  // Seal release before disposing the publisher because disposal can reenter the release check.
  #releaseIfUnused() {
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
      this.#report = undefined;
      this.#callbacks.release(this as ContributionStore<unknown>);
    }
  }
}
