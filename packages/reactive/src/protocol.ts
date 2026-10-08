// Structural protocols are independent; their runtime rules have one generated source.

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

export type Resource = Disposable | AsyncDisposable;

/** Structural observable protocol shared by signals, ContributionViews and diagnostics. */
export interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}
