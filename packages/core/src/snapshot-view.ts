import type { Disposable } from "./resource";

export interface SnapshotView<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

interface SnapshotSubscriptionBinding {
  readonly listener: () => void;
  readonly detach: (subscription: SnapshotSubscription) => void;
}

const snapshotSubscriptionBindings = new WeakMap<
  SnapshotSubscription,
  SnapshotSubscriptionBinding
>();

type SnapshotPublisherState<T> =
  | {
      readonly phase: "active";
      readonly read: () => T;
      readonly report: (error: unknown) => void;
    }
  | { readonly phase: "disposed" };

/** Synchronous writer for immutable operational snapshots. */
export class SnapshotPublisher<T> implements Disposable {
  readonly #subscriptions = new Set<SnapshotSubscription>();
  #state: SnapshotPublisherState<T>;
  #snapshot: T;
  #dirty = false;

  constructor(read: () => T, report: (error: unknown) => void) {
    if (typeof read !== "function") throw new TypeError("Snapshot reader must be a function");
    if (typeof report !== "function") {
      throw new TypeError("Snapshot error reporter must be a function");
    }
    this.#state = { phase: "active", read, report };
    this.#snapshot = read();
    Object.freeze(this);
  }

  readonly view: SnapshotView<T> = Object.freeze({
    get: () => this.#get(),
    subscribe: (listener: () => void) => this.#subscribe(listener),
  });

  invalidate() {
    const { report } = this.#requireActive();
    this.#dirty = true;
    for (const subscription of [...this.#subscriptions]) {
      try {
        notifySnapshotSubscription(subscription);
      } catch (error) {
        report(error);
      }
    }
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposed") return;
    this.#state = { phase: "disposed" };
    try {
      this.#materialize(state.read);
    } finally {
      this.#dirty = false;
      const subscriptions = [...this.#subscriptions];
      this.#subscriptions.clear();
      for (const subscription of subscriptions) closeSnapshotSubscription(subscription);
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  #get() {
    const state = this.#state;
    if (state.phase === "active") this.#materialize(state.read);
    return this.#snapshot;
  }

  #subscribe(listener: () => void): Disposable {
    if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
    this.#requireActive();

    const subscription = new SnapshotSubscription(listener, (current) => {
      this.#subscriptions.delete(current);
    });
    this.#subscriptions.add(subscription);
    return subscription;
  }

  #materialize(read: () => T) {
    if (!this.#dirty) return;
    this.#snapshot = read();
    this.#dirty = false;
  }

  #requireActive() {
    const state = this.#state;
    if (state.phase === "disposed") throw new TypeError("Snapshot publisher is disposed");
    return state;
  }
}

class SnapshotSubscription implements Disposable {
  constructor(listener: () => void, detach: (subscription: SnapshotSubscription) => void) {
    snapshotSubscriptionBindings.set(this, { listener, detach });
    Object.freeze(this);
  }

  dispose() {
    const binding = snapshotSubscriptionBindings.get(this);
    if (!binding) return;
    snapshotSubscriptionBindings.delete(this);
    binding.detach(this);
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

function notifySnapshotSubscription(subscription: SnapshotSubscription) {
  snapshotSubscriptionBindings.get(subscription)?.listener();
}

function closeSnapshotSubscription(subscription: SnapshotSubscription) {
  snapshotSubscriptionBindings.delete(subscription);
}
