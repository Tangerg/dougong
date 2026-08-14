export type Awaitable<T> = T | PromiseLike<T>;

export interface Disposable {
  dispose(): void | Promise<void>;
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface Publication extends Disposable {
  publish(): void;
}

export interface StagedResource<T extends Disposable> extends Publication {
  readonly handle: T;
}
