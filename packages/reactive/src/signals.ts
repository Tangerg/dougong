import { assertListener, disposeSymbol, type Disposable, type Readable } from "./protocol.js";
import { assertSynchronous } from "./async-result.js";

declare const dougongSignal: unique symbol;

export interface ReadonlySignal<T> extends Readable<T> {
  readonly [dougongSignal]: true;
}

export interface Signal<T> extends ReadonlySignal<T> {
  readonly set: (value: T) => void;
}

type Listener = () => void;
type SynchronousResult<T> = T & Exclude<T, PromiseLike<unknown>>;
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
  version: number;
  subscription: Disposable | undefined;
};

// Synchronous collection avoids adding tracking context to every read; restore it before the calculation returns.
// A write is the only event that can invalidate a pure calculation, even when its graph is unobserved.
let writeVersion = 0;
let batchDepth = 0;
let flushing = false;
let propagating = false;
const pendingSlots = new Set<ListenerSlot>();
const pendingInvalidations = new Set<ListenerSlot>();
let activeSources: Set<ReactiveNode> | undefined;
const refreshing: ComputedNode<unknown>[] = [];

class ReactiveSubscription implements Disposable {
  #dispose: (() => void) | undefined;

  constructor(dispose: () => void) {
    this.#dispose = dispose;
    Object.freeze(this);
  }

  [disposeSymbol]() {
    const dispose = this.#dispose;
    this.#dispose = undefined;
    dispose?.();
  }
}

function flushPendingListeners() {
  if (flushing) return;
  const errors: unknown[] = [];
  flushing = true;
  try {
    while (pendingSlots.size) {
      const slot = pendingSlots.values().next().value!;
      pendingSlots.delete(slot);
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
    flushing = false;
  }
  throwListenerFailures(errors);
}

function publish(slots: ReadonlySet<ListenerSlot>) {
  // Capture membership before delivery so new subscriptions wait for a subsequent publication.
  for (const slot of slots) {
    (slot.kind === "dependency" ? pendingInvalidations : pendingSlots).add(slot);
  }
  // Capture downstream membership at the write, including inside batches and reentrant
  // observers. Delaying graph invalidation would deliver old writes to new subscribers.
  if (propagating) return;
  propagating = true;
  try {
    while (pendingInvalidations.size) {
      const slot = pendingInvalidations.values().next().value!;
      pendingInvalidations.delete(slot);
      const invalidate = slot.listener;
      invalidate?.();
    }
  } finally {
    propagating = false;
    pendingInvalidations.clear();
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

// Queue subscriptions rather than callbacks so distinct subscriptions are never merged.
export function batch<T>(callback: () => SynchronousResult<T>): T {
  if (typeof callback !== "function") throw new TypeError("batch() expects a function");
  batchDepth++;

  let outcome:
    { readonly succeeded: true; readonly value: T } | { readonly succeeded: false; error: unknown };

  try {
    const value = callback();
    assertSynchronous(value, "Reactive batches must be synchronous");
    outcome = { succeeded: true, value };
  } catch (error) {
    outcome = { succeeded: false, error };
  } finally {
    batchDepth--;
  }

  if (!batchDepth) {
    try {
      flushPendingListeners();
    } catch (error) {
      outcome = outcome.succeeded
        ? { succeeded: false, error }
        : {
            succeeded: false,
            error: new AggregateError([outcome.error, error], "Reactive batch failed"),
          };
    }
  }

  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
}

export function signal<T>(initialValue: T): Signal<T> {
  return new SignalNode(initialValue).view;
}

export function computed<T>(calculate: () => SynchronousResult<T>): ReadonlySignal<T> {
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
        activeSources?.add(this);
        return this.#value;
      },
      set: (value: T) => this.#set(value),
      subscribe: (listener: Listener) => subscribeSlot(this.#listeners, listener, "observer"),
    }) as Signal<T>;
  }

  get version() {
    return this.#version;
  }

  refresh() {}

  subscribeInvalidation(listener: Listener) {
    return subscribeSlot(this.#listeners, listener, "dependency");
  }

  #set(value: T) {
    if (activeSources) {
      throw new TypeError("Computed signal calculations cannot write signals");
    }
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    writeVersion++;
    this.#version++;
    publish(this.#listeners);
  }
}

type ComputedResult<T> =
  | { readonly phase: "value"; readonly value: T }
  | { readonly phase: "error"; readonly error: unknown };

// Unobserved computed nodes hold no subscriptions, so live sources cannot retain unused derived values.
class ComputedNode<T> implements ReactiveNode {
  readonly #calculate: () => T;
  readonly #listeners = new Set<ListenerSlot>();
  readonly #dependencies = new Map<ReactiveNode, Dependency>();
  #result: ComputedResult<T> | undefined;
  #checkedAt = -1;
  #evaluationDepth: number | undefined;
  #sources: Set<ReactiveNode> | undefined;
  #invalidatedAt = -1;
  #version = 0;

  readonly view: ReadonlySignal<T>;

  constructor(calculate: () => T) {
    this.#calculate = calculate;
    this.view = Object.freeze({
      get: () => this.#get(),
      subscribe: (listener: Listener) => this.#subscribe(listener),
    }) as ReadonlySignal<T>;
  }

  get version() {
    return this.#version;
  }

  refresh() {
    if (this.#evaluationDepth !== undefined) {
      if (activeSources) this.#collectCycleInputs(this.#evaluationDepth, activeSources);
      throw new TypeError("Circular computed signal");
    }
    this.#evaluationDepth = refreshing.length;
    refreshing.push(this);
    try {
      this.#refresh();
    } finally {
      refreshing.pop();
      this.#evaluationDepth = undefined;
    }
  }

  // A back edge cannot be subscribed to. Track the writable inputs that can break the cycle,
  // including cached edges that were being validated before a calculation read back into them.
  #collectCycleInputs(start: number, sources: Set<ReactiveNode>) {
    const inputs = new Set<ReactiveNode>();
    for (const node of refreshing.slice(start)) {
      for (const input of node.#sources ?? node.#dependencies.keys()) inputs.add(input);
    }
    for (const input of inputs) {
      if (input instanceof ComputedNode) {
        for (const source of input.#dependencies.keys()) inputs.add(source);
      } else sources.add(input);
    }
  }

  #get() {
    this.refresh();
    // Failed calculations still create dependencies; circular refresh must fail before adding a back edge.
    activeSources?.add(this);
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

    if (wasUnobserved || kind === "observer") {
      try {
        this.refresh();
        if (kind === "observer") this.#readResult();
        if (wasUnobserved) this.#attachDependencies();
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
    // A diamond shares one publication, but an unread cache must still forward later writes.
    if (this.#invalidatedAt === writeVersion) return;
    this.#invalidatedAt = writeVersion;
    publish(this.#listeners);
  };

  #detachDependencies() {
    for (const dependency of this.#dependencies.values()) {
      dependency.subscription?.[disposeSymbol]();
      dependency.subscription = undefined;
    }
  }

  #attachDependencies() {
    for (const [node, entry] of this.#dependencies) {
      entry.subscription ??= node.subscribeInvalidation(this.#invalidate);
    }
  }

  #refresh() {
    const current = this.#result;
    if (
      current &&
      this.#invalidatedAt <= this.#checkedAt &&
      (this.#checkedAt === writeVersion || !this.#dependenciesChanged())
    ) {
      this.#checkedAt = writeVersion;
      return;
    }

    const sources = new Set<ReactiveNode>();
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
    this.#checkedAt = writeVersion;
    if (this.#listeners.size) this.#attachDependencies();
  }

  #dependenciesChanged() {
    for (const [node, dependency] of this.#dependencies) {
      // An old edge may now be cyclic. Reevaluate the actual branch before recording a failure.
      if (node instanceof ComputedNode && node.#evaluationDepth !== undefined) return true;
      node.refresh();
      if (dependency.version !== node.version) return true;
    }
    return this.#invalidatedAt > this.#checkedAt;
  }

  #evaluate(sources: Set<ReactiveNode>): ComputedResult<T> {
    const previous = activeSources;
    this.#sources = sources;
    activeSources = sources;

    try {
      const calculate = this.#calculate;
      const value = calculate();
      assertSynchronous(value, "Computed signal calculations must be synchronous");
      return { phase: "value", value };
    } catch (error) {
      return { phase: "error", error };
    } finally {
      activeSources = previous;
      this.#sources = undefined;
    }
  }

  #reconcileDependencies(sources: ReadonlySet<ReactiveNode>) {
    // Track dependencies on failure too so later source changes can recover the calculation.
    for (const [dependency, entry] of this.#dependencies) {
      if (sources.has(dependency)) continue;
      entry.subscription?.[disposeSymbol]();
      this.#dependencies.delete(dependency);
    }

    for (const node of sources) {
      const entry = this.#dependencies.get(node);
      if (entry) entry.version = node.version;
      else this.#dependencies.set(node, { version: node.version, subscription: undefined });
    }
  }
}
