import { asyncDisposeSymbol, disposeSymbol } from "./disposal-runtime.js";
import { assertSynchronous, type SynchronousResult } from "./async-result.js";

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
  subscribe<Result>(listener: () => SynchronousResult<Result>): Disposable;
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
    rejectHandle(subscription, "Readable.subscribe() must return a Disposable");
  return () =>
    assertSynchronous(
      Reflect.apply(release, subscription, []),
      "Readable subscriptions must dispose synchronously",
    );
}

export function captureRelease(value: AsyncDisposable, message: string): () => PromiseLike<void> {
  const release = value?.[asyncDisposeSymbol];
  if (typeof release !== "function") rejectHandle(value, message);
  return () => Reflect.apply(release, value, []);
}

function rejectHandle(value: unknown, message: string): never {
  // A misplaced async factory can still reject after its synchronous caller has unwound.
  assertSynchronous(value, message);
  throw new TypeError(message);
}

export function assertListener(listener: unknown): asserts listener is () => void {
  if (typeof listener !== "function") {
    throw new TypeError("Signal subscriber must be a function");
  }
}
