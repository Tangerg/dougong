export type Awaitable<T> = T | PromiseLike<T>;

export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type Resource = Disposable | AsyncDisposable;

export interface Publication extends Disposable {
  publish(): void;
}

export interface StagedResource<T extends Disposable> extends Publication {
  readonly handle: T;
}
