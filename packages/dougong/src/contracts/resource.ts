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
  readonly handle: object;
  publish(): void;
}

export interface ResourceAuthority {
  claim(resource: Resource): () => void;
  markControlHandle(handle: object): void;
}

interface ResourceIdentity {
  readonly kind: "control" | "claim";
}

const controlHandleIdentity: ResourceIdentity = Object.freeze({ kind: "control" });
const invalidResourceMessage = "Resource must implement Symbol.dispose or Symbol.asyncDispose";
const invalidAuthorityMessage = "ResourceAuthority must implement claim and markControlHandle";

class ResourceIdentityAuthority implements ResourceAuthority {
  // Control provenance survives release; external claims end only through their own reservation.
  readonly #identities = new WeakMap<object, ResourceIdentity>();

  claim(resource: Resource): () => void {
    assertResourceIdentity(resource);
    const identity = this.#identities.get(resource);
    if (identity) {
      throw new TypeError(
        identity.kind === "control"
          ? "Owned control handles cannot be adopted as resources"
          : "Resource already has a Lifetime owner",
      );
    }
    const reservation: ResourceIdentity = { kind: "claim" };
    this.#identities.set(resource, reservation);
    let binding: { readonly resource: Resource } | undefined = { resource };
    return () => {
      const current = binding;
      binding = undefined;
      if (current && this.#identities.get(current.resource) === reservation)
        this.#identities.delete(current.resource);
    };
  }

  markControlHandle(handle: object): void {
    this.#identities.set(handle, controlHandleIdentity);
  }
}

export function createResourceAuthority(): ResourceAuthority {
  return Object.freeze(new ResourceIdentityAuthority());
}

type ClaimReleaseState =
  | { readonly phase: "owned"; readonly release: () => unknown }
  | { readonly phase: "releasing" | "released" }
  | { readonly phase: "failed"; readonly error: unknown };

class ClaimRelease {
  #state: ClaimReleaseState;

  constructor(release: () => unknown) {
    this.#state = { phase: "owned", release };
  }

  readonly release = () => {
    const state = this.#state;
    if (state.phase === "failed") throw state.error;
    if (state.phase !== "owned") return;
    this.#state = { phase: "releasing" };
    try {
      assertSynchronous(state.release(), "ResourceAuthority claim release must be synchronous");
      this.#state = { phase: "released" };
    } catch (error) {
      this.#state = { phase: "failed", error };
      throw error;
    }
  };
}

export function captureResourceAuthority(value: unknown): ResourceAuthority {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    throw new TypeError(invalidAuthorityMessage);
  const { claim, markControlHandle } = value as Partial<ResourceAuthority>;
  if (typeof claim !== "function" || typeof markControlHandle !== "function")
    throw new TypeError(invalidAuthorityMessage);
  return Object.freeze({
    claim(resource: Resource) {
      const release = Reflect.apply(claim, value, [resource]);
      // A callable receipt is the release capability; unrelated then metadata cannot defer its ownership.
      if (typeof release !== "function") {
        assertSynchronous(release, "ResourceAuthority.claim must be synchronous");
        throw new TypeError("ResourceAuthority.claim must return a release function");
      }
      return new ClaimRelease(() => Reflect.apply(release, undefined, [])).release;
    },
    markControlHandle(handle: object) {
      assertSynchronous(
        Reflect.apply(markControlHandle, value, [handle]),
        "ResourceAuthority.markControlHandle must be synchronous",
      );
    },
  });
}

function assertResourceIdentity(resource: unknown) {
  if ((typeof resource !== "object" && typeof resource !== "function") || resource === null) {
    throw new TypeError(invalidResourceMessage);
  }
}

export function captureDisposer(resource: Resource): () => Awaitable<void> {
  assertResourceIdentity(resource);
  const asynchronous = (resource as Partial<AsyncDisposable>)[asyncDisposeSymbol];
  if (asynchronous !== undefined && asynchronous !== null) {
    if (typeof asynchronous !== "function")
      throw new TypeError("Symbol.asyncDispose must be a function");
    return () => Reflect.apply(asynchronous, resource, []);
  }
  const synchronous = (resource as Partial<Disposable>)[disposeSymbol];
  if (typeof synchronous !== "function") {
    throw new TypeError(invalidResourceMessage);
  }
  return () =>
    assertSynchronous(
      Reflect.apply(synchronous, resource, []),
      "Symbol.dispose must be synchronous",
    );
}
