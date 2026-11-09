// Asynchronous snapshot subscribers could resume against a state newer than the notification they received.

import { disposeSymbol, type Disposable } from "../contracts/resource.js";
import { assertSynchronous, type SynchronousResult } from "../internal/async-result.js";
import { RecordedFailure } from "../contracts/errors.js";

export interface SnapshotView<T> {
  get(): T;
  subscribe<Result>(listener: () => SynchronousResult<Result>): Disposable;
}

type SnapshotErrorReporter = (error: unknown) => SynchronousResult<void>;

const snapshotReportingFailureMessage = "Snapshot error reporting failed";

interface SnapshotSubscriptionBinding {
  readonly listener: () => void;
  readonly report: SnapshotErrorReporter;
  readonly detach: (subscription: SnapshotSubscription) => void;
}

// Separate bindings let retained subscription handles release their callback and owner edges on disposal.
const snapshotSubscriptionBindings = new WeakMap<
  SnapshotSubscription,
  SnapshotSubscriptionBinding
>();

class SnapshotNotificationQueue {
  readonly #pending = new Map<SnapshotSubscription, SnapshotErrorReporter | undefined>();
  #batchDepth = 0;
  #flushing = false;
  #boundary: SnapshotErrorReporter | undefined;

  batch<Result>(
    operation: () => SynchronousResult<Result>,
    reportNotificationFailure?: SnapshotErrorReporter,
  ) {
    if (
      reportNotificationFailure !== undefined &&
      typeof reportNotificationFailure !== "function"
    ) {
      throw new TypeError("Snapshot notification error reporter must be a function");
    }
    const previousBoundary = this.#boundary;
    this.#boundary = reportNotificationFailure ?? previousBoundary;
    this.#batchDepth++;
    const errors: unknown[] = [];
    try {
      assertSynchronous(operation(), "Snapshot notification batches must be synchronous");
    } catch (error) {
      errors.push(error);
    } finally {
      this.#batchDepth--;
      try {
        if (!this.#batchDepth) this.#flush();
      } catch (error) {
        errors.push(error);
      } finally {
        this.#boundary = previousBoundary;
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Snapshot batch failed");
  }

  enqueue(subscriptions: ReadonlySet<SnapshotSubscription>) {
    for (const subscription of subscriptions) {
      // Coalescing adds no new notification; its first enqueue keeps responsibility until delivery.
      if (!this.#pending.has(subscription)) this.#pending.set(subscription, this.#boundary);
    }
    if (!this.#batchDepth) this.#flush();
  }

  cancel(subscription: SnapshotSubscription) {
    this.#pending.delete(subscription);
  }

  #flush() {
    if (this.#flushing) return;
    this.#flushing = true;
    const failures: unknown[] = [];
    try {
      while (this.#pending.size) {
        const [subscription, boundary] = this.#pending.entries().next().value!;
        this.#pending.delete(subscription);
        const previousBoundary = this.#boundary;
        // The creating batch can already have returned; reentrant notifications retain its error boundary.
        this.#boundary = boundary;
        try {
          notifySnapshotSubscription(subscription, boundary, failures);
        } finally {
          this.#boundary = previousBoundary;
        }
      }
    } finally {
      this.#flushing = false;
      this.#pending.clear();
    }
    if (failures.length) {
      throw new AggregateError(failures, snapshotReportingFailureMessage);
    }
  }
}

// One queue keeps related snapshots atomic without making its drain caller own every notification failure.
const snapshotNotifications = new SnapshotNotificationQueue();

export function batchSnapshotNotifications<Result>(
  operation: () => SynchronousResult<Result>,
  reportNotificationFailure?: SnapshotErrorReporter,
) {
  snapshotNotifications.batch<Result>(operation, reportNotificationFailure);
}

type SnapshotPublisherState<T> =
  | {
      readonly phase: "active";
      readonly read: () => T;
      readonly report: SnapshotErrorReporter;
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

  constructor(read: () => T, report: SnapshotErrorReporter) {
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
    snapshotNotifications.enqueue(this.#subscriptions);
  }

  [disposeSymbol]() {
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
    report: SnapshotErrorReporter,
    detach: (subscription: SnapshotSubscription) => void,
  ) {
    snapshotSubscriptionBindings.set(this, { listener, report, detach });
    Object.freeze(this);
  }

  [disposeSymbol]() {
    const binding = snapshotSubscriptionBindings.get(this);
    if (!binding) return;
    closeSnapshotSubscription(this);
    binding.detach(this);
  }
}

function notifySnapshotSubscription(
  subscription: SnapshotSubscription,
  reportNotificationFailure: SnapshotErrorReporter | undefined,
  failures: unknown[],
) {
  const binding = snapshotSubscriptionBindings.get(subscription);
  if (!binding) return;
  try {
    const { listener } = binding;
    assertSynchronous(listener(), "Snapshot subscribers must be synchronous");
  } catch (subscriberError) {
    try {
      const { report } = binding;
      assertSynchronous(report(subscriberError), "Snapshot error reporters must be synchronous");
    } catch (reporterError) {
      if (!reportNotificationFailure) {
        failures.push(subscriberError, reporterError);
        return;
      }
      const notificationFailure = new AggregateError(
        [subscriberError, reporterError],
        snapshotReportingFailureMessage,
      );
      try {
        assertSynchronous(
          reportNotificationFailure(notificationFailure),
          "Snapshot notification error reporters must be synchronous",
        );
      } catch (boundaryError) {
        const terminalFailure = new AggregateError(
          [notificationFailure, boundaryError],
          "Snapshot notification error boundary failed",
        );
        // A terminal reporter has no lower boundary; its failure cannot rewrite the operation's result.
        queueMicrotask(() => {
          throw terminalFailure;
        });
      }
    }
  }
}

function closeSnapshotSubscription(subscription: SnapshotSubscription) {
  snapshotNotifications.cancel(subscription);
  snapshotSubscriptionBindings.delete(subscription);
}
