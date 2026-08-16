export type Awaitable<T> = T | PromiseLike<T>;

/** Fails at module load before an unavailable Promise primitive reaches a lifecycle transition. */
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

/** Canonical runtime key for Dougong's synchronous disposal protocol. */
export const disposeSymbol: typeof Symbol.dispose = resolveDisposalSymbol(
  Symbol.dispose,
  "Symbol.dispose",
) as typeof Symbol.dispose;
/** Canonical runtime key for Dougong's asynchronous disposal protocol. */
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

export interface Publication extends Disposable {
  publish(): void;
}

export interface StagedResource<T extends Disposable> extends Publication {
  readonly handle: T;
}
