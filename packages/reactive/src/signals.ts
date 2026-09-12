// A small synchronous reactive graph. Independent of @dougongjs/core by design:
// neither package imports the other, and `check-layers.mjs` enforces it. They
// meet only at the structural `Readable` protocol — `get()` plus `subscribe()` —
// which a Signal, a ContributionView and a diagnostics view all satisfy without
// knowing about each other.
//
// Three ideas, and that is the whole model:
//
//   signal    a value with subscribers
//   computed  a derived value that tracks its own dependencies
//   batch     defer notification until a group of writes is done
//
// Everything is synchronous and pull-based. `set()` marks and notifies; nothing
// recomputes until someone reads. A `computed` nobody reads costs nothing, and a
// read is never stale, because staleness is checked at read time rather than
// pushed eagerly.

import { disposeSymbol, type Disposable, type Readable } from "./protocol";
import { assertSynchronous } from "./sync-result";

declare const dougongSignal: unique symbol;

/** A reactive node created by Dougong and safe to compose with computed(). */
export interface ReadonlySignal<T> extends Readable<T> {
  readonly [dougongSignal]: true;
}

export interface Signal<T> extends ReadonlySignal<T> {
  readonly set: (value: T) => void;
}

type Listener = () => void;
interface ListenerSlot {
  readonly kind: "dependency" | "observer";
  listener: Listener | undefined;
}
type ReactiveNode = {
  readonly version: number;
  refresh(): void;
  subscribeInvalidation(listener: Listener): Disposable;
};

type Dependency = {
  readonly node: ReactiveNode;
  version: number;
  subscription: Disposable | undefined;
};

// Module-level state, which is unusual enough to justify.
//
// `activeCollector` is how dependency tracking works without the caller
// declaring anything: while a `computed` evaluates, it installs a collector, and
// every `get()` reached during that evaluation reports itself. The alternative —
// passing a context through every read — would put the mechanism in the API.
//
// `batchDepth` and `pendingSlots` are the batch. `nodes` maps a public signal
// back to its internal node, weakly, so a signal nobody holds is collectable.
//
// All of it is single-threaded and synchronous. Nothing here survives a turn:
// the collector is restored in a `finally`, and pending slots are flushed before
// the outermost `batch()` returns.
let batchDepth = 0;
let flushing = false;
const pendingSlots = new Set<ListenerSlot>();
const pendingInvalidations = new Set<ListenerSlot>();
let activeCollector: ((source: ReadonlySignal<unknown>) => void) | undefined;
const nodes = new WeakMap<ReadonlySignal<unknown>, ReactiveNode>();

function createSubscription(dispose: () => void): Disposable {
  return new ReactiveSubscription(dispose);
}

class ReactiveSubscription implements Disposable {
  #dispose: (() => void) | undefined;

  constructor(dispose: () => void) {
    this.#dispose = dispose;
    Object.freeze(this);
  }

  dispose() {
    const dispose = this.#dispose;
    this.#dispose = undefined;
    dispose?.();
  }

  [disposeSymbol]() {
    this.dispose();
  }
}

// Settle dependency invalidations before delivering observer callbacks. This
// holds for unequal paths too: notifying halfway through a diamond would let a
// read clear its dirty flag before the other path invalidates it again.
function flushPendingListeners() {
  if (flushing) return;
  const errors: unknown[] = [];
  flushing = true;
  try {
    while (pendingInvalidations.size || pendingSlots.size) {
      const queue = pendingInvalidations.size ? pendingInvalidations : pendingSlots;
      const slot = queue.values().next().value!;
      queue.delete(slot);
      const listener = slot.listener;
      if (!listener) continue;
      try {
        assertSynchronous(listener(), "Signal subscribers must be synchronous");
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    pendingSlots.clear();
    pendingInvalidations.clear();
    flushing = false;
  }
  throwListenerFailures(errors);
}

function publish(slots: ReadonlySet<ListenerSlot>) {
  // Capture membership before invoking anyone. Subscribing during notification
  // only creates a slot; a subsequent publication must enqueue it explicitly.
  for (const slot of slots) {
    (slot.kind === "dependency" ? pendingInvalidations : pendingSlots).add(slot);
  }
  if (!batchDepth) flushPendingListeners();
}

function subscribeSlot(
  listeners: Set<ListenerSlot>,
  listener: Listener,
  kind: ListenerSlot["kind"],
) {
  assertListener(listener);
  const slot: ListenerSlot = { kind, listener };
  listeners.add(slot);
  return createSubscription(() => {
    slot.listener = undefined;
    listeners.delete(slot);
  });
}

function throwListenerFailures(errors: unknown[]) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Reactive subscribers failed");
  }
}

function track(source: ReadonlySignal<unknown>) {
  activeCollector?.(source);
}

/**
 * Defers notification until the outermost batch returns, so a group of writes is
 * observed once. Nested calls join the outer batch.
 *
 * Notifications are queued by subscription, not by callback, so the same
 * function subscribed to two signals is still called twice — deduplicating by
 * callback would silently merge two independent subscriptions.
 *
 * If both the body and the flush fail, both errors are reported. A subscriber
 * failing during flush must not hide why the batch itself failed.
 */
export function batch<T>(callback: () => T): T {
  if (typeof callback !== "function") throw new TypeError("batch() expects a function");
  batchDepth++;

  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; error: unknown };

  try {
    const value = callback();
    assertSynchronous(value, "Reactive batches must be synchronous");
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    batchDepth--;
  }

  if (!batchDepth) {
    try {
      flushPendingListeners();
    } catch (error) {
      outcome = outcome.ok
        ? { ok: false, error }
        : { ok: false, error: new AggregateError([outcome.error, error], "Reactive batch failed") };
    }
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * A value with subscribers. Writes are compared with `Object.is`, so setting the
 * same value notifies nobody — which is what makes `computed` chains stable
 * under idempotent updates.
 */
export function signal<T>(initialValue: T): Signal<T> {
  let value = initialValue;
  let version = 0;
  const listeners = new Set<ListenerSlot>();

  const source = {
    get() {
      track(source as ReadonlySignal<unknown>);
      return value;
    },

    set(nextValue) {
      if (activeCollector) {
        throw new TypeError("Computed signal calculations cannot write signals");
      }
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      version++;

      publish(listeners);
    },

    subscribe(listener) {
      return subscribeSlot(listeners, listener, "observer");
    },
  } as Signal<T>;

  nodes.set(source as ReadonlySignal<unknown>, {
    get version() {
      return version;
    },
    refresh() {},
    subscribeInvalidation: (listener) => subscribeSlot(listeners, listener, "dependency"),
  });

  return Object.freeze(source);
}

export function computed<T>(calculate: () => T): ReadonlySignal<T> {
  if (typeof calculate !== "function") throw new TypeError("computed() expects a function");
  return new ComputedNode(calculate).view;
}

type ComputedResult<T> =
  | { readonly phase: "value"; readonly value: T }
  | { readonly phase: "error"; readonly error: unknown };

/**
 * A derived value that discovers its own dependencies by evaluating.
 *
 * Two modes, and the difference matters:
 *
 * Unobserved — nobody has subscribed — it holds no subscriptions to its
 * dependencies at all. Freshness is checked lazily on read by comparing each
 * dependency's version. So an unused `computed` is inert and cannot keep the
 * signals it reads alive through a listener.
 *
 * Observed — someone has subscribed — it subscribes to its dependencies so it can
 * notify onward. Dropping the last subscriber detaches them again.
 *
 * Dependencies are re-collected on every evaluation, so a conditional branch that
 * stops being taken stops being a dependency. `#version` advances only when the
 * result changes (including transitions into and out of failure), so an equal
 * result does not force an unobserved downstream calculation to run again.
 */
class ComputedNode<T> implements ReactiveNode {
  readonly #calculate: () => T;
  readonly #listeners = new Set<ListenerSlot>();
  readonly #dependencies = new Map<ReadonlySignal<unknown>, Dependency>();
  #result: ComputedResult<T> | undefined;
  #evaluating = false;
  #dirty = true;
  #version = 0;

  readonly view: ReadonlySignal<T>;

  constructor(calculate: () => T) {
    this.#calculate = calculate;
    this.view = Object.freeze({
      get: () => this.#get(),
      subscribe: (listener: Listener) => this.#subscribe(listener),
    }) as ReadonlySignal<T>;
    nodes.set(this.view, this);
  }

  get version() {
    return this.#version;
  }

  refresh() {
    if (this.#evaluating) throw new TypeError("Circular computed signal");
    this.#evaluating = true;
    try {
      this.#refresh();
    } finally {
      this.#evaluating = false;
    }
  }

  #get() {
    this.refresh();
    // An unsuccessful calculation is still a dependency. A circular refresh,
    // however, must fail before creating an edge back to an evaluating node.
    track(this.view);
    return this.#readResult();
  }

  #readResult(): T {
    const result = this.#result!;
    if (result.phase === "error") throw result.error;
    return result.value;
  }

  subscribeInvalidation(listener: Listener) {
    return this.#subscribe(listener, "dependency");
  }

  #subscribe(listener: Listener, kind: ListenerSlot["kind"] = "observer") {
    assertListener(listener);
    const slot: ListenerSlot = { kind, listener };
    const wasUnobserved = this.#listeners.size === 0;
    this.#listeners.add(slot);

    if (wasUnobserved) {
      try {
        this.refresh();
        if (kind === "observer") this.#readResult();
        this.#attachDependencies();
      } catch (error) {
        this.#listeners.delete(slot);
        if (!this.#listeners.size) this.#detachDependencies();
        throw error;
      }
    }

    return createSubscription(() => {
      slot.listener = undefined;
      this.#listeners.delete(slot);
      if (!this.#listeners.size) this.#detachDependencies();
    });
  }

  readonly #invalidate = () => {
    if (this.#dirty) return;
    this.#dirty = true;
    publish(this.#listeners);
  };

  #detachDependencies() {
    for (const dependency of this.#dependencies.values()) {
      dependency.subscription?.dispose();
      dependency.subscription = undefined;
    }
  }

  #attachDependencies() {
    for (const entry of this.#dependencies.values()) {
      entry.subscription ??= entry.node.subscribeInvalidation(this.#invalidate);
    }
  }

  #refresh() {
    const current = this.#result;
    if (current && !this.#dirty) {
      for (const dependency of this.#dependencies.values()) {
        dependency.node.refresh();
        if (dependency.version !== dependency.node.version) {
          this.#dirty = true;
          break;
        }
      }
      if (!this.#dirty) return;
    }

    const sources = new Set<ReadonlySignal<unknown>>();
    const previousCollector = activeCollector;
    activeCollector = (source) => sources.add(source);

    let next: ComputedResult<T>;
    try {
      const value = this.#calculate();
      assertSynchronous(value, "Computed signal calculations must be synchronous");
      next = { phase: "value", value };
    } catch (error) {
      next = { phase: "error", error };
    } finally {
      activeCollector = previousCollector;
    }

    // Failure is a settled result too. Collect its dependencies so subsequent
    // changes can recover, and let callers handle it in their own calculation.
    for (const [dependency, entry] of this.#dependencies) {
      if (sources.has(dependency)) continue;
      entry.subscription?.dispose();
      this.#dependencies.delete(dependency);
    }

    for (const dependency of sources) {
      const node = nodes.get(dependency);
      if (!node) continue;

      const entry = this.#dependencies.get(dependency) ?? {
        node,
        version: node.version,
        subscription: undefined,
      };
      entry.version = node.version;
      this.#dependencies.set(dependency, entry);
    }

    if (
      !current ||
      (next.phase === "value"
        ? current.phase !== "value" || !Object.is(current.value, next.value)
        : current.phase !== "error" || !Object.is(current.error, next.error))
    ) {
      this.#version++;
    }
    this.#result = next;
    this.#dirty = false;
    if (this.#listeners.size) this.#attachDependencies();
  }
}

function assertListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}
