export type Awaitable<T> = T | PromiseLike<T>;

export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "./disposal-runtime";

// Required symbol methods prevent half-implemented resources from satisfying the disposal protocol.

export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type Resource = Disposable | AsyncDisposable;

// Stage declarations until their complete activation layer succeeds to hide partially built Instances.
export interface Publication extends Disposable {
  publish(): void;
}

export interface StagedResource<T extends Disposable> extends Publication {
  readonly handle: T;
}
