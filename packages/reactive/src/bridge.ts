import {
  asyncDisposeSymbol,
  captureReadable,
  captureUnsubscribe,
  disposeSymbol,
  type AsyncDisposable,
  type Disposable,
  type Readable,
} from "./protocol.js";
import { signal, type ReadonlySignal, type Signal } from "./signals.js";

export interface BridgeOwner {
  readonly defer: (dispose: () => unknown) => AsyncDisposable;
}

type BridgeValue<T> =
  | { readonly phase: "active"; readonly source: Readable<T>; readonly value: T }
  | { readonly phase: "disposed" };

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
  #release: (() => void) | undefined;
  #reading: symbol | undefined;
  #failure: { readonly value: unknown } | undefined;
  readonly view: ReadonlySignal<T>;

  constructor(source: Readable<T>) {
    this.#value = signal<BridgeValue<T>>({ phase: "active", source, value: source.get() });
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
    let attaching = true;
    let releaseRegistration: (() => PromiseLike<void>) | undefined;
    try {
      const cleanup = owner.defer(() => {
        this[disposeSymbol]();
        // A synchronously revoked attachment may still return a subscription whose release fails.
        return attaching ? Promise.resolve().then(() => this.#checkRelease()) : undefined;
      });
      const close = cleanup?.[asyncDisposeSymbol];
      if (typeof close !== "function") {
        throw new TypeError("BridgeOwner.defer() must return an AsyncDisposable");
      }
      releaseRegistration = close.bind(cleanup);
      const state = this.#value.get();
      if (state.phase === "disposed") throw new Error("Readable bridge has been disposed");
      const release = captureUnsubscribe(state.source.subscribe(() => this.#refresh()));
      this.#release = release;
      if (this.#value.get().phase === "disposed") {
        try {
          release();
          this.#release = undefined;
        } catch (error) {
          this.#failure = { value: error };
        }
        throw new Error("Readable bridge has been disposed");
      }
      // Re-read after subscription so a source change during attachment cannot be lost.
      this.#refresh();
      if (this.#value.get().phase === "disposed")
        throw new Error("Readable bridge has been disposed");
    } catch (error) {
      // The synchronous factory unwinds the bridge; the owner's registration joins that same outcome.
      if (releaseRegistration)
        void Promise.resolve()
          .then(releaseRegistration)
          .catch(() => undefined);
      throw error;
    } finally {
      attaching = false;
    }
  }

  #checkRelease() {
    if (this.#failure) throw this.#failure.value;
  }

  #refresh() {
    const before = this.#value.get();
    if (before.phase === "disposed") return;
    // A foreign getter may deliver another notification before returning an obsolete value.
    const read = Symbol();
    this.#reading = read;
    try {
      const value = before.source.get();
      if (this.#reading !== read || this.#value.get() !== before || Object.is(before.value, value))
        return;
      this.#value.set({ ...before, value });
    } finally {
      this.#reading = undefined;
    }
  }

  #subscribe(listener: () => void): Disposable {
    if (this.#value.get().phase === "disposed")
      throw new Error("Readable bridge has been disposed");
    const inner = this.#value.subscribe(listener);
    const subscription = new BridgeSubscription(() => {
      this.#subscriptions.delete(subscription);
      inner[disposeSymbol]();
    });
    this.#subscriptions.add(subscription);
    return subscription;
  }

  [disposeSymbol]() {
    if (this.#value.get().phase === "disposed") return this.#checkRelease();
    const errors: unknown[] = [];
    try {
      this.#value.set({ phase: "disposed" });
    } catch (error) {
      // A pure calculation may reject a write before it happens; ownership has not changed in that case.
      if (this.#value.get().phase !== "disposed") throw error;
      errors.push(error);
    }
    try {
      this.#release?.();
      this.#release = undefined;
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
  const captured = captureReadable(source, "bridge()");
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
