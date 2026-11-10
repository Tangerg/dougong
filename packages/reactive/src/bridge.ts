import {
  captureRelease,
  captureReadable,
  captureUnsubscribe,
  disposeSymbol,
  assertListener,
  type AsyncDisposable,
  type Disposable,
  type Readable,
} from "./protocol.js";
import { batch, signal, type ReadonlySignal, type Signal } from "./signals.js";
import { resolveValue } from "./async-result.js";

export interface BridgeOwner {
  readonly defer: (dispose: () => unknown) => AsyncDisposable;
}

const disposedBridgeMessage = "Readable bridge has been disposed";

type BridgeValue<T> =
  | { readonly outcome: "value"; readonly source: Readable<T>; readonly value: T }
  | { readonly outcome: "error"; readonly source: Readable<T>; readonly error: unknown }
  | undefined;

class ReadableBridge<T> implements Disposable {
  #value: Signal<BridgeValue<T>> | undefined;
  #release: (() => void) | undefined;
  #reading: symbol | undefined;
  #failure: { readonly value: unknown } | undefined;
  readonly view: ReadonlySignal<T>;

  constructor(source: Readable<T>) {
    this.#value = signal<BridgeValue<T>>({ outcome: "value", source, value: source.get() });
    this.view = Object.freeze({
      get: () => {
        const state = this.#value?.get();
        if (!state) throw new Error(disposedBridgeMessage);
        if (state.outcome === "error") throw state.error;
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
      releaseRegistration = captureRelease(
        cleanup,
        "BridgeOwner.defer() must return an AsyncDisposable",
      );
      const state = this.#value?.get();
      if (!state) throw new Error(disposedBridgeMessage);
      const release = captureUnsubscribe(state.source.subscribe(() => this.#refresh()));
      this.#release = release;
      if (!this.#value?.get()) {
        try {
          release();
          this.#release = undefined;
        } catch (error) {
          this.#failure = { value: error };
        }
        throw new Error(disposedBridgeMessage);
      }
      // Re-read after subscription so a source change during attachment cannot be lost.
      this.#refresh();
      this.view.get();
    } catch (error) {
      // The synchronous factory unwinds the bridge; the owner's registration joins that same outcome.
      const release = releaseRegistration;
      if (release)
        void Promise.resolve()
          .then(() => resolveValue(release()))
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
    // Deliver subscribers outside foreign getters so a superseded read cannot swallow their errors.
    batch(() => {
      const before = this.#value?.get();
      if (!before) return;
      // A foreign getter may deliver another notification before returning an obsolete value.
      const read = Symbol();
      this.#reading = read;
      try {
        const { source } = before;
        let next: BridgeValue<T>;
        try {
          next = { outcome: "value", source, value: source.get() };
        } catch (error) {
          next = { outcome: "error", source, error };
        }
        if (this.#reading !== read || this.#value?.get() !== before) return;
        if (
          before.outcome === "value" &&
          next.outcome === "value" &&
          Object.is(before.value, next.value)
        )
          return;
        if (
          before.outcome === "error" &&
          next.outcome === "error" &&
          Object.is(before.error, next.error)
        )
          return;
        this.#value?.set(next);
      } finally {
        this.#reading = undefined;
      }
    });
  }

  #subscribe(listener: () => void): Disposable {
    const value = this.#value;
    if (!value?.get()) throw new Error(disposedBridgeMessage);
    assertListener(listener);
    const subscription = value.subscribe(() => {
      // A batch may deliver termination later. Keep the slot until delivery or explicit withdrawal.
      if (!this.#value?.get()) subscription[disposeSymbol]();
      return listener();
    });
    return subscription;
  }

  [disposeSymbol]() {
    const value = this.#value;
    if (!value?.get()) return this.#checkRelease();
    const errors: unknown[] = [];
    try {
      value.set(undefined);
    } catch (error) {
      // A pure calculation may reject a write before it happens; ownership has not changed in that case.
      if (value.get()) throw error;
      errors.push(error);
    }
    // A retained terminal bridge must no longer root the computed graph that observed this signal.
    this.#value = undefined;
    try {
      this.#release?.();
      this.#release = undefined;
    } catch (error) {
      errors.push(error);
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
  const capturedOwner: BridgeOwner = { defer: (dispose) => Reflect.apply(defer, owner, [dispose]) };
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
