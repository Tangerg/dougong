// Disposal declarations; runtime semantics come from the generated protocol.

export type Awaitable<T> = T | PromiseLike<T>;

export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "./disposal-runtime";

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
