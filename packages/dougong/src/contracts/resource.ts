import { asyncDisposeSymbol, disposeSymbol } from "../internal/disposal-runtime.js";
import { assertSynchronous } from "../internal/async-result.js";

export type Awaitable<T> = T | PromiseLike<T>;

export {
  assertPromiseRuntime,
  resolveDisposalSymbol,
  asyncDisposeSymbol,
  disposeSymbol,
} from "../internal/disposal-runtime.js";

export interface Disposable {
  [Symbol.dispose](): void;
}

export interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export type Resource = Disposable | AsyncDisposable;

export interface Publication extends Disposable {
  publish(): void;
}

interface ResourceIdentity {
  readonly kind: "control" | "claim";
}

// Control provenance survives release; external claims end only through their own reservation.
const resourceIdentities = new WeakMap<Resource, ResourceIdentity>();
const controlHandleIdentity: ResourceIdentity = Object.freeze({ kind: "control" });

export function markOwnedControlHandle<T extends Resource>(handle: T): T {
  resourceIdentities.set(handle, controlHandleIdentity);
  return handle;
}

export function claimResource(resource: Resource): () => void {
  const identity = resourceIdentities.get(resource);
  if (identity) {
    throw new TypeError(
      identity.kind === "control"
        ? "Owned control handles cannot be adopted as resources"
        : "Resource already has a Lifetime owner",
    );
  }
  const reservation: ResourceIdentity = { kind: "claim" };
  resourceIdentities.set(resource, reservation);
  return () => {
    if (resourceIdentities.get(resource) === reservation) resourceIdentities.delete(resource);
  };
}

export function captureDisposer(resource: Resource): () => Awaitable<void> {
  if ((typeof resource !== "object" && typeof resource !== "function") || resource === null) {
    throw new TypeError("Resource must implement Symbol.dispose or Symbol.asyncDispose");
  }
  const asynchronous = (resource as Partial<AsyncDisposable>)[asyncDisposeSymbol];
  if (asynchronous !== undefined && asynchronous !== null) {
    if (typeof asynchronous !== "function")
      throw new TypeError("Symbol.asyncDispose must be a function");
    return () => Reflect.apply(asynchronous, resource, []);
  }
  const synchronous = (resource as Partial<Disposable>)[disposeSymbol];
  if (typeof synchronous !== "function") {
    throw new TypeError("Resource must implement Symbol.dispose or Symbol.asyncDispose");
  }
  return () =>
    assertSynchronous(
      Reflect.apply(synchronous, resource, []),
      "Symbol.dispose must be synchronous",
    );
}
