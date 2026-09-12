// The observation protocol behind every diagnostics surface in Dougong.
//
// Reads are lazy: `invalidate()` only marks the snapshot dirty and notifies, and
// the reader function runs on the next `get()`. A Host that changes a hundred
// times while nobody is looking therefore builds zero snapshots.
//
// Subscribers must be synchronous. An async subscriber would resume after the
// state it was told about had already moved on, which is exactly the torn read
// this type exists to prevent.

import { disposeSymbol, type Disposable } from "./resource";
import { assertSynchronous } from "./sync-result";

export interface SnapshotView<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

interface SnapshotSubscriptionBinding {
  readonly listener: () => void;
  readonly report: (error: unknown) => void;
  readonly detach: (subscription: SnapshotSubscription) => void;
}

// The listener and the detach closure live outside the subscription object so
// the handle a caller retains holds no strong edge to either. Disposing deletes
// the entry, and a dropped handle takes its binding with it — a retained
// subscription cannot keep a Host alive through a callback it no longer needs.
const snapshotSubscriptionBindings = new WeakMap<
  SnapshotSubscription,
  SnapshotSubscriptionBinding
>();

// Core commits all snapshot values before any observer runs. A subscription is
// the notification identity; writes from a callback join the drain without
// recursively entering application code. Core and reactive own separate queues.
const pendingSubscriptions = new Set<SnapshotSubscription>();
let batchDepth = 0;
let flushing = false;

/** Internal synchronous commit boundary for related snapshots. */
export function batchSnapshotNotifications(operation: () => void) {
  batchDepth++;
  const errors: unknown[] = [];
  try {
    operation();
  } catch (error) {
    errors.push(error);
  } finally {
    batchDepth--;
    if (!batchDepth) {
      try {
        flushNotifications();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Snapshot batch failed");
}

function flushNotifications() {
  if (flushing) return;
  flushing = true;
  const failures: unknown[] = [];
  try {
    while (pendingSubscriptions.size) {
      const subscription = pendingSubscriptions.values().next().value!;
      pendingSubscriptions.delete(subscription);
      notifySnapshotSubscription(subscription, failures);
    }
  } finally {
    flushing = false;
    pendingSubscriptions.clear();
  }
  if (failures.length) {
    throw new AggregateError(failures, "Snapshot error reporting failed");
  }
}

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
    this.#requireActive();
    this.#dirty = true;
    for (const subscription of this.#subscriptions) pendingSubscriptions.add(subscription);
    if (!batchDepth) flushNotifications();
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposed") return;
    this.#state = { phase: "disposed" };
    try {
      // Materialize one last time so `get()` keeps answering after disposal with
      // the final state rather than a stale one. A disposed publisher stops
      // accepting writes; it does not stop being readable.
      this.#materialize(state.read);
    } finally {
      this.#dirty = false;
      const subscriptions = [...this.#subscriptions];
      this.#subscriptions.clear();
      for (const subscription of subscriptions) closeSnapshotSubscription(subscription);
    }
  }

  [disposeSymbol]() {
    this.dispose();
  }

  #get() {
    const state = this.#state;
    if (state.phase === "active") this.#materialize(state.read);
    return this.#snapshot;
  }

  #subscribe(listener: () => void): Disposable {
    if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
    const { report } = this.#requireActive();

    const subscription = new SnapshotSubscription(listener, report, (current) => {
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
  constructor(
    listener: () => void,
    report: (error: unknown) => void,
    detach: (subscription: SnapshotSubscription) => void,
  ) {
    snapshotSubscriptionBindings.set(this, { listener, report, detach });
    Object.freeze(this);
  }

  dispose() {
    const binding = snapshotSubscriptionBindings.get(this);
    if (!binding) return;
    closeSnapshotSubscription(this);
    binding.detach(this);
  }

  [disposeSymbol]() {
    this.dispose();
  }
}

function notifySnapshotSubscription(subscription: SnapshotSubscription, failures: unknown[]) {
  const binding = snapshotSubscriptionBindings.get(subscription);
  if (!binding) return;
  try {
    assertSynchronous(binding.listener(), "Snapshot subscribers must be synchronous");
  } catch (subscriberError) {
    try {
      assertSynchronous(
        binding.report(subscriberError),
        "Snapshot error reporters must be synchronous",
      );
    } catch (reporterError) {
      failures.push(subscriberError, reporterError);
    }
  }
}

function closeSnapshotSubscription(subscription: SnapshotSubscription) {
  pendingSubscriptions.delete(subscription);
  snapshotSubscriptionBindings.delete(subscription);
}
