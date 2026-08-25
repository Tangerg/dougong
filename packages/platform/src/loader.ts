// How a Reference becomes a module. One method, returning `unknown`, because a
// Loader's job ends at "here is what that reference resolved to" — validating
// that it default-exports a Plugin whose name matches the Manifest belongs to
// `artifact.ts`, in one place, for every Loader.
//
// The two implementations here are the honest ones for a same-realm runtime.
// Neither isolates anything, and neither pretends to.

export interface Loader<Reference> {
  /** The result is awaited and structurally validated at the Artifact boundary. */
  readonly load: (reference: Reference, signal: AbortSignal) => unknown;
}

/** Trusted same-Realm ESM loading. It is intentionally not presented as a sandbox. */
export class ImportLoader implements Loader<string | URL> {
  readonly load = async (reference: string | URL, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const module = await import(/* @vite-ignore */ String(reference));
    signal.throwIfAborted();
    return module;
  };
}

/** Deterministic loader useful for embedded bundles, tests and application-owned modules. */
export class MemoryLoader<Reference> implements Loader<Reference> {
  readonly #modules: ReadonlyMap<unknown, unknown>;

  constructor(modules: ReadonlyMap<Reference, unknown>) {
    if (
      !modules ||
      (typeof modules !== "object" && typeof modules !== "function") ||
      typeof modules.get !== "function" ||
      typeof modules.has !== "function" ||
      typeof modules[Symbol.iterator] !== "function"
    ) {
      throw new TypeError("MemoryLoader modules must be a ReadonlyMap");
    }
    this.#modules = new Map<unknown, unknown>(modules);
  }

  readonly load = (reference: Reference, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!this.#modules.has(reference)) throw new TypeError("Unknown module reference");
    return this.#modules.get(reference);
  };
}
