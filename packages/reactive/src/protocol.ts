export interface Disposable {
  dispose(): void | Promise<void>;
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

/** Structural observable protocol shared by signals, extensions and diagnostics. */
export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}
