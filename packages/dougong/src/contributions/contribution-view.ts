import { DougongError, lifetimeDisposedCode } from "../contracts/errors.js";
import type { Lifetime } from "../lifetime/lifetime.js";
import type { ResolvedValue } from "../internal/async-result.js";
import { disposeSymbol, type Awaitable, type Disposable } from "../contracts/resource.js";
import type { SnapshotView } from "../observation/snapshot-view.js";

export interface ContributionView<T> extends SnapshotView<ReadonlyArray<string>> {
  use<Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>>;
}

export type ContributionLease = (resource: Disposable) => () => void;

export interface ContributionSource<T> {
  snapshot(): ReadonlyArray<string>;
  subscribe(listener: () => void, lease?: ContributionLease): Disposable;
  use<Result>(
    id: string,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>>;
}

interface ActiveViewBinding<T> {
  readonly phase: "active";
  readonly source: ContributionSource<T>;
  readonly lease?: ContributionLease;
  readonly owner?: Lifetime;
}

interface SealedViewBinding {
  readonly phase: "sealed";
  readonly snapshot: ReadonlyArray<string>;
}

// Revocable bindings prevent a retained view from keeping its released store alive.
export interface ContributionViewState<T> {
  binding: ActiveViewBinding<T> | SealedViewBinding | undefined;
}

export class ContributionViewHandle<T> implements ContributionView<T> {
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
        const { source } = this.#requireBinding();
        if (typeof callback !== "function")
          throw new TypeError("Contribution callback must be a function");
        return source.use(id, callback);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    Object.freeze(this);
  }

  #read() {
    const current = this.#state.binding;
    if (current?.phase === "sealed") return current.snapshot;
    return this.#requireBinding().source.snapshot();
  }

  #subscribe(listener: () => void) {
    const binding = this.#requireBinding();
    if (typeof listener !== "function")
      throw new TypeError("Contribution subscriber must be a function");
    return binding.source.subscribe(() => {
      if (binding.owner && !binding.owner.acceptsWork) return;
      return listener();
    }, binding.lease);
  }

  #requireBinding() {
    const binding = this.#state.binding;
    if (!binding)
      throw new DougongError(lifetimeDisposedCode, "Contribution view has been disposed");
    if (binding.phase === "sealed")
      throw new DougongError(lifetimeDisposedCode, "Contribution view has been sealed");
    if (binding.owner && !binding.owner.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Contribution view owner is closed");
    }
    return binding;
  }
}

// The owner's release revokes the view, then returns the store reference it counted.
export class ContributionViewLease<T> implements Disposable {
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

export class ContributionSubscription implements Disposable {
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
