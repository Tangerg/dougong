import {
  asyncDisposeSymbol,
  disposeSymbol,
  type AsyncDisposable,
  type Disposable,
  type Readable,
} from "./protocol.js";
import { signal, type ReadonlySignal, type Signal } from "./signals.js";
import { assertSynchronous } from "./sync-result.js";

export interface BridgeOwner {
  readonly defer: (dispose: () => unknown) => AsyncDisposable;
}

type BridgeValue<T> =
  { readonly phase: "active"; readonly value: T } | { readonly phase: "disposed" };

class BridgeSubscription implements Disposable {
  #release: (() => void) | undefined;

  constructor(release: () => void) {
    this.#release = release;
    Object.freeze(this);
  }

  [disposeSymbol]() {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}

class ReadableBridge<T> implements Disposable {
  readonly #value: Signal<BridgeValue<T>>;
  readonly #subscriptions = new Set<Disposable>();
  #source: Readable<T> | undefined;
  #release: (() => void) | undefined;
  #failure: { readonly value: unknown } | undefined;
  readonly view: ReadonlySignal<T>;

  constructor(source: Readable<T>) {
    this.#source = source;
    this.#value = signal<BridgeValue<T>>({ phase: "active", value: source.get() });
    this.view = Object.freeze({
      get: () => {
        const state = this.#value.get();
        if (state.phase === "disposed") throw new Error("Readable bridge has been disposed");
        return state.value;
      },
      subscribe: (listener: () => void) => this.#subscribe(listener),
    }) as ReadonlySignal<T>;
  }

  start(owner: BridgeOwner) {
    const cleanup = owner.defer(() => this[disposeSymbol]());
    if (!cleanup || typeof cleanup[asyncDisposeSymbol] !== "function") {
      throw new TypeError("BridgeOwner.defer() must return an AsyncDisposable");
    }
    const source = this.#source;
    if (!source) throw new Error("Readable bridge has been disposed");
    const subscription = source.subscribe(() => this.#refresh());
    const dispose = subscription?.[disposeSymbol];
    if (typeof dispose !== "function") {
      throw new TypeError("Readable.subscribe() must return a Disposable");
    }
    const release = () =>
      assertSynchronous(
        dispose.call(subscription),
        "Readable subscriptions must dispose synchronously",
      );
    if (!this.#source) {
      release();
      throw new Error("Readable bridge has been disposed");
    }
    this.#release = release;
    // Re-read after subscription so a source change during attachment cannot be lost.
    this.#refresh();
  }

  #refresh() {
    const source = this.#source;
    if (!source) return;
    const value = source.get();
    const previous = this.#value.get();
    if (previous.phase === "active" && Object.is(previous.value, value)) return;
    this.#value.set({ phase: "active", value });
  }

  #subscribe(listener: () => void): Disposable {
    if (!this.#source) throw new Error("Readable bridge has been disposed");
    const inner = this.#value.subscribe(listener);
    const subscription = new BridgeSubscription(() => {
      this.#subscriptions.delete(subscription);
      inner[disposeSymbol]();
    });
    this.#subscriptions.add(subscription);
    return subscription;
  }

  [disposeSymbol]() {
    if (!this.#source) {
      if (this.#failure) throw this.#failure.value;
      return;
    }
    this.#source = undefined;
    const release = this.#release;
    const errors: unknown[] = [];
    try {
      release?.();
      this.#release = undefined;
    } catch (error) {
      // Failed unsubscription remains owned; later owner shutdown must not report it clean.
      errors.push(error);
    }
    try {
      this.#value.set({ phase: "disposed" });
    } catch (error) {
      errors.push(error);
    } finally {
      for (const subscription of this.#subscriptions) subscription[disposeSymbol]();
      this.#subscriptions.clear();
    }
    if (errors.length) {
      const failure =
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Readable bridge cleanup failed");
      this.#failure = { value: failure };
      throw failure;
    }
  }
}

export function bridge<T>(owner: BridgeOwner, source: Readable<T>): ReadonlySignal<T> {
  const defer = owner?.defer;
  if (typeof defer !== "function") {
    throw new TypeError("bridge() expects a resource owner");
  }
  const get = source?.get;
  const subscribe = source?.subscribe;
  if (typeof get !== "function" || typeof subscribe !== "function") {
    throw new TypeError("bridge() expects a readable source");
  }
  const captured = Object.freeze({ get: get.bind(source), subscribe: subscribe.bind(source) });
  const capturedOwner: BridgeOwner = { defer: (dispose) => defer.call(owner, dispose) };
  const instance = new ReadableBridge(captured);
  try {
    instance.start(capturedOwner);
    return instance.view;
  } catch (error) {
    try {
      instance[disposeSymbol]();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Readable bridge construction failed");
    }
    throw error;
  }
}
