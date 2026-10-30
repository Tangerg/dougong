import { asyncDisposeSymbol, disposeSymbol } from "../internal/disposal-runtime.js";
import { assertSynchronous } from "../internal/sync-result.js";

export type Awaitable<T> = T | PromiseLike<T>;

export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "../internal/disposal-runtime.js";

export interface Disposable {
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export type Resource = Disposable | AsyncDisposable;

export interface Publication extends Disposable {
  publish(): void;
}

export function captureDisposer(resource: Resource): () => Awaitable<void> {
  if ((typeof resource !== "object" && typeof resource !== "function") || resource === null) {
    throw new TypeError("Resource must implement Symbol.dispose or Symbol.asyncDispose");
  }
  const asynchronous = (resource as Partial<AsyncDisposable>)[asyncDisposeSymbol];
  if (asynchronous !== undefined && asynchronous !== null) {
    if (typeof asynchronous !== "function")
      throw new TypeError("Symbol.asyncDispose must be a function");
    return () => Reflect.apply(asynchronous, resource, []);
  }
  const synchronous = (resource as Partial<Disposable>)[disposeSymbol];
  if (typeof synchronous !== "function") {
    throw new TypeError("Resource must implement Symbol.dispose or Symbol.asyncDispose");
  }
  return () =>
    assertSynchronous(
      Reflect.apply(synchronous, resource, []),
      "Symbol.dispose must be synchronous",
    );
}
