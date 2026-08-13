export interface Disposable {
  dispose(): void | Promise<void>;
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

/** A value that can be read and observed, regardless of which library owns it. */
export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

declare const dougongSignal: unique symbol;

/** A reactive node created by Dougong and safe to compose with computed(). */
export interface ReadonlySignal<T> extends Readable<T> {
  readonly [dougongSignal]: true;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
}

type Listener = () => void;
type ReactiveNode = {
  readonly version: number;
  refresh(): void;
};

type Dependency = {
  readonly source: ReadonlySignal<unknown>;
  readonly node: ReactiveNode;
  version: number;
  subscription: Disposable | undefined;
};

let batchDepth = 0;
let pendingListeners: Set<Listener> | undefined;
let activeCollector: ((source: ReadonlySignal<unknown>) => void) | undefined;
const nodes = new WeakMap<ReadonlySignal<unknown>, ReactiveNode>();

function disposable(dispose: () => void): Disposable {
  let active = true;

  return {
    dispose() {
      if (!active) return;
      active = false;
      dispose();
    },
  };
}

function flush() {
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
  batchDepth++;

  let result!: T;
  let failure: unknown;
  let failed = false;

  try {
    result = callback();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    batchDepth--;
  }

  if (!batchDepth) {
    try {
      flush();
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
      listeners.add(listener);
      return disposable(() => listeners.delete(listener));
    },
  } as Signal<T>;

  nodes.set(source as ReadonlySignal<unknown>, {
    get version() {
      return version;
    },
    refresh() {},
  });

  return source;
}

export function computed<T>(calculate: () => T): ReadonlySignal<T> {
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
        source: dependency,
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

      return disposable(() => {
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

  return source;
}
