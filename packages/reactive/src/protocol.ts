import { disposeSymbol } from "./disposal-runtime.js";
import { assertSynchronous } from "./sync-result.js";

export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "./disposal-runtime.js";

export interface Disposable {
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

export function captureReadable<T>(source: Readable<T>, operation: string): Readable<T> {
  const get = source?.get;
  const subscribe = source?.subscribe;
  if (typeof get !== "function" || typeof subscribe !== "function")
    throw new TypeError(`${operation} expects a readable source`);
  return Object.freeze({
    get: () => Reflect.apply(get, source, []),
    subscribe: (listener: () => void) => Reflect.apply(subscribe, source, [listener]),
  });
}

export function captureUnsubscribe(subscription: Disposable): () => void {
  const release = subscription?.[disposeSymbol];
  if (typeof release !== "function")
    throw new TypeError("Readable.subscribe() must return a Disposable");
  return () =>
    assertSynchronous(
      Reflect.apply(release, subscription, []),
      "Readable subscriptions must dispose synchronously",
    );
}

export function assertListener(listener: unknown): asserts listener is () => void {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}
