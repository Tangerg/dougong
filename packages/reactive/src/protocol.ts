export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "./disposal-runtime";

export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}
