import { disposeSymbol, type Disposable, type Readable } from "./protocol";
import { assertSynchronous } from "./sync-result";

export type { AsyncDisposable, Disposable, Readable } from "./protocol";

declare const dougongSignal: unique symbol;

/** A reactive node created by Dougong and safe to compose with computed(). */
export interface ReadonlySignal<T> extends Readable<T> {
  readonly [dougongSignal]: true;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
}

export {
  observe,
  type ObservationLifetime,
  type ObservationOwner,
  type ObservationTask,
  type Observer,
} from "./observe";

type Listener = () => void;
interface ListenerSlot {
  listener: Listener | undefined;
}
type ReactiveNode = {
  readonly version: number;
  refresh(): void;
};

type Dependency = {
  readonly node: ReactiveNode;
  version: number;
  subscription: Disposable | undefined;
};

let batchDepth = 0;
let pendingSlots: Set<ListenerSlot> | undefined;
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

function flushPendingListeners() {
  const errors: unknown[] = [];

  while (pendingSlots?.size) {
    const slots = pendingSlots;
    pendingSlots = new Set();

    notifySlots(slots, errors);
  }

  pendingSlots = undefined;
  throwListenerFailures(errors);
}

function publish(slots: ReadonlySet<ListenerSlot>) {
  if (batchDepth) {
    const pending = (pendingSlots ??= new Set());
    for (const slot of slots) pending.add(slot);
    return;
  }

  const errors: unknown[] = [];
  notifySlots(slots, errors);
  throwListenerFailures(errors);
}

function notifySlots(slots: Iterable<ListenerSlot>, errors: unknown[]) {
  for (const slot of slots) {
    const listener = slot.listener;
    if (!listener) continue;
    try {
      listener();
    } catch (error) {
      errors.push(error);
    }
  }
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
  let value = initialValue;
  let version = 0;
  const listeners = new Set<ListenerSlot>();

  const source = {
    get() {
      track(source as ReadonlySignal<unknown>);
      return value;
    },

    set(nextValue) {
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      version++;

      publish(listeners);
    },

    subscribe(listener) {
      assertListener(listener);
      const slot: ListenerSlot = { listener };
      listeners.add(slot);
      return createSubscription(() => {
        slot.listener = undefined;
        listeners.delete(slot);
      });
    },
  } as Signal<T>;

  nodes.set(source as ReadonlySignal<unknown>, {
    get version() {
      return version;
    },
    refresh() {},
  });

  return Object.freeze(source);
}

export function computed<T>(calculate: () => T): ReadonlySignal<T> {
  if (typeof calculate !== "function") throw new TypeError("computed() expects a function");
  return new ComputedNode(calculate).view;
}

type ComputedValue<T> =
  { readonly phase: "uninitialized" } | { readonly phase: "cached"; readonly value: T };

class ComputedNode<T> implements ReactiveNode {
  readonly #calculate: () => T;
  readonly #listeners = new Set<ListenerSlot>();
  readonly #dependencies = new Map<ReadonlySignal<unknown>, Dependency>();
  #value: ComputedValue<T> = { phase: "uninitialized" };
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
    this.#evaluate();
  }

  #get() {
    track(this.view);
    return this.#evaluate();
  }

  #subscribe(listener: Listener) {
    assertListener(listener);
    const slot: ListenerSlot = { listener };
    const wasUnobserved = this.#listeners.size === 0;
    this.#listeners.add(slot);

    if (wasUnobserved) {
      try {
        this.#dirty = true;
        this.#evaluate();
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

  #evaluate(): T {
    const current = this.#value;
    if (current.phase === "cached" && !this.#dirty) {
      for (const dependency of this.#dependencies.values()) {
        dependency.node.refresh();
        if (dependency.version !== dependency.node.version) {
          this.#dirty = true;
          break;
        }
      }
      if (!this.#dirty) return current.value;
    }
    if (this.#evaluating) throw new TypeError("Circular computed signal");

    const sources = new Set<ReadonlySignal<unknown>>();
    const previousCollector = activeCollector;
    this.#evaluating = true;
    activeCollector = (source) => sources.add(source);

    let nextValue: T;
    try {
      nextValue = this.#calculate();
      assertSynchronous(nextValue, "Computed signal calculations must be synchronous");
    } finally {
      activeCollector = previousCollector;
      this.#evaluating = false;
    }

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
      if (this.#listeners.size && !entry.subscription) {
        entry.subscription = dependency.subscribe(this.#invalidate);
      }
      this.#dependencies.set(dependency, entry);
    }

    if (current.phase === "uninitialized" || !Object.is(current.value, nextValue)) {
      this.#version++;
    }
    this.#value = { phase: "cached", value: nextValue };
    this.#dirty = false;
    return nextValue;
  }
}

function assertListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}
