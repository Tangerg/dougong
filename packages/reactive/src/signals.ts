import { disposeSymbol, type Disposable, type Readable } from "./protocol";
import { assertSynchronous } from "./sync-result";

declare const dougongSignal: unique symbol;

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

// Synchronous collection avoids adding tracking context to every read; restore it before the calculation returns.
let batchDepth = 0;
let flushing = false;
const pendingSlots = new Set<ListenerSlot>();
const pendingInvalidations = new Set<ListenerSlot>();
let activeCollector: ((source: ReadonlySignal<unknown>) => void) | undefined;
const nodes = new WeakMap<ReadonlySignal<unknown>, ReactiveNode>();

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

// Drain dependency invalidations first so diamond observers cannot read before all paths become dirty.
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
  // Capture membership before delivery so new subscriptions wait for a subsequent publication.
  for (const slot of slots) {
    (slot.kind === "dependency" ? pendingInvalidations : pendingSlots).add(slot);
  }
  if (!batchDepth) flushPendingListeners();
}

function subscribeSlot(
  listeners: Set<ListenerSlot>,
  listener: Listener,
  kind: ListenerSlot["kind"],
): Disposable {
  assertListener(listener);
  const slot: ListenerSlot = { kind, listener };
  listeners.add(slot);
  return new ReactiveSubscription(() => {
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

// Queue subscriptions rather than callbacks so distinct subscriptions are never merged.
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

export function signal<T>(initialValue: T): Signal<T> {
  return new SignalNode(initialValue).view;
}

export function computed<T>(calculate: () => T): ReadonlySignal<T> {
  if (typeof calculate !== "function") throw new TypeError("computed() expects a function");
  return new ComputedNode(calculate).view;
}

class SignalNode<T> implements ReactiveNode {
  readonly #listeners = new Set<ListenerSlot>();
  #value: T;
  #version = 0;
  readonly view: Signal<T>;

  constructor(initialValue: T) {
    this.#value = initialValue;
    this.view = Object.freeze({
      get: () => {
        track(this.view);
        return this.#value;
      },
      set: (value: T) => this.#set(value),
      subscribe: (listener: Listener) => subscribeSlot(this.#listeners, listener, "observer"),
    }) as Signal<T>;
    nodes.set(this.view, this);
  }

  get version() {
    return this.#version;
  }

  refresh() {}

  subscribeInvalidation(listener: Listener) {
    return subscribeSlot(this.#listeners, listener, "dependency");
  }

  #set(value: T) {
    if (activeCollector) {
      throw new TypeError("Computed signal calculations cannot write signals");
    }
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    this.#version++;
    publish(this.#listeners);
  }
}

type ComputedResult<T> =
  | { readonly phase: "value"; readonly value: T }
  | { readonly phase: "error"; readonly error: unknown };

// Unobserved computed nodes hold no subscriptions, preventing unused derived values from retaining their sources.
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
    // Failed calculations still create dependencies; circular refresh must fail before adding a back edge.
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

  #subscribe(listener: Listener, kind: ListenerSlot["kind"] = "observer"): Disposable {
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

    return new ReactiveSubscription(() => {
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
    if (current && !this.#dirty && !this.#dependenciesChanged()) return;
    this.#dirty = true;

    const sources = new Set<ReadonlySignal<unknown>>();
    const next = this.#evaluate(sources);
    this.#reconcileDependencies(sources);

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

  #dependenciesChanged() {
    for (const dependency of this.#dependencies.values()) {
      dependency.node.refresh();
      if (dependency.version !== dependency.node.version) return true;
    }
    return this.#dirty;
  }

  #evaluate(sources: Set<ReadonlySignal<unknown>>): ComputedResult<T> {
    const previousCollector = activeCollector;
    activeCollector = (source) => sources.add(source);

    try {
      const value = this.#calculate();
      assertSynchronous(value, "Computed signal calculations must be synchronous");
      return { phase: "value", value };
    } catch (error) {
      return { phase: "error", error };
    } finally {
      activeCollector = previousCollector;
    }
  }

  #reconcileDependencies(sources: ReadonlySet<ReadonlySignal<unknown>>) {
    // Track dependencies on failure too so later source changes can recover the calculation.
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
  }
}

function assertListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}
