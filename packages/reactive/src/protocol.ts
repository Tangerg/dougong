/** Fails at module load before an unavailable Promise primitive reaches an observation. */
export function assertPromiseRuntime(
  withResolvers: unknown,
): asserts withResolvers is typeof Promise.withResolvers {
  if (typeof withResolvers !== "function") {
    throw new Error("Unsupported JavaScript runtime: Promise.withResolvers is required");
  }
}

/** Resolves the conventional protocol key without mutating the ambient Symbol constructor. */
export function resolveDisposalSymbol(
  native: symbol | undefined,
  name: "Symbol.dispose" | "Symbol.asyncDispose",
) {
  return native ?? Symbol.for(name);
}

assertPromiseRuntime(Promise.withResolvers);

export const disposeSymbol: typeof Symbol.dispose = resolveDisposalSymbol(
  Symbol.dispose,
  "Symbol.dispose",
) as typeof Symbol.dispose;
export const asyncDisposeSymbol: typeof Symbol.asyncDispose = resolveDisposalSymbol(
  Symbol.asyncDispose,
  "Symbol.asyncDispose",
) as typeof Symbol.asyncDispose;

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
