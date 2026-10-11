// Async snapshot subscribers could resume against a state newer than the notification they received.

import { disposeSymbol, type Disposable } from "./resource";
import { assertSynchronous } from "./sync-result";
import { RecordedFailure } from "./errors";

export interface SnapshotView<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

interface SnapshotSubscriptionBinding {
  readonly listener: () => void;
  readonly report: (error: unknown) => void;
  readonly detach: (subscription: SnapshotSubscription) => void;
}

// Separate bindings let retained subscription handles release their callback and owner edges on disposal.
const snapshotSubscriptionBindings = new WeakMap<
  SnapshotSubscription,
  SnapshotSubscriptionBinding
>();

// Commit related snapshots before callbacks so reentrant reads cannot observe a torn update.
const pendingSubscriptions = new Set<SnapshotSubscription>();
let batchDepth = 0;
let flushing = false;

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

type SnapshotResult<T> =
  | { readonly phase: "value"; readonly value: T }
  | { readonly phase: "error"; readonly error: RecordedFailure };

export class SnapshotPublisher<T> implements Disposable {
  readonly #subscriptions = new Set<SnapshotSubscription>();
  #state: SnapshotPublisherState<T>;
  #snapshot: SnapshotResult<T>;
  #dirty = false;
  #reading = false;

  constructor(read: () => T, report: (error: unknown) => void) {
    if (typeof read !== "function") throw new TypeError("Snapshot reader must be a function");
    if (typeof report !== "function") {
      throw new TypeError("Snapshot error reporter must be a function");
    }
    this.#state = { phase: "active", read, report };
    this.#snapshot = { phase: "value", value: read() };
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
    if (this.#reading) {
      throw new TypeError("Cannot dispose a snapshot publisher while its reader is running");
    }
    this.#state = { phase: "disposed" };
    try {
      // Seal the final read before detaching so retained views cannot present stale data as success.
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
    if (this.#reading) throw new TypeError("Circular snapshot read");
    const state = this.#state;
    if (state.phase === "active") this.#materialize(state.read);
    const snapshot = this.#snapshot;
    if (snapshot.phase === "error") throw snapshot.error;
    return snapshot.value;
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
    batchSnapshotNotifications(() => {
      // Commit the read before notification because reading another snapshot can reenter this publisher.
      this.#dirty = false;
      this.#reading = true;
      try {
        this.#snapshot = { phase: "value", value: read() };
      } catch (error) {
        this.#dirty = true;
        if (this.#state.phase === "disposed") {
          // A terminal read cannot retain an obsolete successful value after its final read failed.
          this.#snapshot = { phase: "error", error: new RecordedFailure(error) };
        }
        throw error;
      } finally {
        this.#reading = false;
      }
    });
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
