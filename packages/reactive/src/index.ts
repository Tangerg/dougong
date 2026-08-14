import type { Disposable, Readable } from "./protocol";

export type { Disposable, Readable } from "./protocol";

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
let pendingListeners: Set<Listener> | undefined;
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

  [Symbol.dispose]() {
    this.dispose();
  }
}

function flushPendingListeners() {
  const errors: unknown[] = [];

  while (pendingListeners?.size) {
    const listeners = pendingListeners;
    pendingListeners = new Set();

    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  pendingListeners = undefined;

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Reactive subscribers failed");
  }
}

function publish(listeners: ReadonlySet<Listener>) {
  if (batchDepth) {
    const pending = (pendingListeners ??= new Set());
    for (const listener of listeners) pending.add(listener);
    return;
  }

  const errors: unknown[] = [];
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      errors.push(error);
    }
  }

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

  let result!: T;
  let failure: unknown;
  let failed = false;

  try {
    result = callback();
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("Reactive batches must be synchronous");
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    batchDepth--;
  }

  if (!batchDepth) {
    try {
      flushPendingListeners();
    } catch (error) {
      failure = failed ? new AggregateError([failure, error], "Reactive batch failed") : error;
      failed = true;
    }
  }

  if (failed) throw failure;
  return result;
}

export function signal<T>(initialValue: T): Signal<T> {
  let value = initialValue;
  let version = 0;
  const listeners = new Set<Listener>();

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
      listeners.add(listener);
      return createSubscription(() => listeners.delete(listener));
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
  let initialized = false;
  let evaluating = false;
  let dirty = true;
  let value!: T;
  let version = 0;

  const listeners = new Set<Listener>();
  const dependencies = new Map<ReadonlySignal<unknown>, Dependency>();

  const invalidate = () => {
    if (dirty) return;
    dirty = true;

    publish(listeners);
  };

  const detach = () => {
    for (const dependency of dependencies.values()) {
      dependency.subscription?.dispose();
      dependency.subscription = undefined;
    }
  };

  const evaluate = () => {
    if (initialized && !dirty) {
      for (const dependency of dependencies.values()) {
        dependency.node.refresh();
        if (dependency.version !== dependency.node.version) {
          dirty = true;
          break;
        }
      }
      if (!dirty) return value;
    }
    if (evaluating) throw new TypeError("Circular computed signal");

    const sources = new Set<ReadonlySignal<unknown>>();
    const previousCollector = activeCollector;
    evaluating = true;
    activeCollector = (source) => sources.add(source);

    let nextValue: T;
    try {
      nextValue = calculate();
      if (isThenable(nextValue)) {
        void Promise.resolve(nextValue).catch(() => undefined);
        throw new TypeError("Computed signal calculations must be synchronous");
      }
    } finally {
      activeCollector = previousCollector;
      evaluating = false;
    }

    for (const [dependency, entry] of dependencies) {
      if (sources.has(dependency)) continue;
      entry.subscription?.dispose();
      dependencies.delete(dependency);
    }

    for (const dependency of sources) {
      const node = nodes.get(dependency);
      if (!node) continue;

      const entry = dependencies.get(dependency) ?? {
        node,
        version: node.version,
        subscription: undefined,
      };
      entry.version = node.version;

      if (listeners.size && !entry.subscription) {
        entry.subscription = dependency.subscribe(invalidate);
      }
      dependencies.set(dependency, entry);
    }

    if (!initialized || !Object.is(value, nextValue)) version++;
    value = nextValue;
    initialized = true;
    dirty = false;
    return value;
  };

  const source = {
    get() {
      track(source as ReadonlySignal<unknown>);
      return evaluate();
    },

    subscribe(listener) {
      assertListener(listener);
      const wasUnobserved = listeners.size === 0;
      listeners.add(listener);

      if (wasUnobserved) {
        try {
          dirty = true;
          evaluate();
        } catch (error) {
          listeners.delete(listener);
          if (!listeners.size) detach();
          throw error;
        }
      }

      return createSubscription(() => {
        listeners.delete(listener);
        if (listeners.size) return;
        detach();
      });
    },
  } as ReadonlySignal<T>;

  nodes.set(source as ReadonlySignal<unknown>, {
    get version() {
      return version;
    },
    refresh: evaluate,
  });

  return Object.freeze(source);
}

function assertListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && "then" in value
  );
}
