// Disposal protocol shared by every owned resource in Core.
//
// Two things are deliberate here. The `dispose()` method and the well-known
// symbol are both required rather than one aliasing the other, so a resource
// works with `using` and with a plain call without a runtime adapter. And the
// symbols are resolved rather than assumed, so an older runtime still gets a
// stable key instead of `undefined`.

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

// Split into two interfaces rather than one with optional members so the symbol
// method is required in each. A single `Disposable | AsyncDisposable` shape with
// optional symbols would let a half-implemented resource typecheck.

export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type Resource = Disposable | AsyncDisposable;

/**
 * A resource created in one step and made visible in another. Declarations made
 * during `setup()` stage first and publish only once their whole layer
 * activates, so no half-built Instance is ever observable.
 */
export interface Publication extends Disposable {
  publish(): void;
}

/** A Publication paired with the public handle its owner hands to Plugin code. */
export interface StagedResource<T extends Disposable> extends Publication {
  readonly handle: T;
}
