export interface Loader<Reference> {
  load(reference: Reference, signal: AbortSignal): unknown | Promise<unknown>;
}

/** Trusted same-Realm ESM loading. It is intentionally not presented as a sandbox. */
export class ImportLoader implements Loader<string | URL> {
  async load(reference: string | URL, signal: AbortSignal) {
    signal.throwIfAborted();
    const module = await import(/* @vite-ignore */ String(reference));
    signal.throwIfAborted();
    return module;
  }
}

/** Deterministic loader useful for embedded bundles, tests and application-owned modules. */
export class MemoryLoader<Reference> implements Loader<Reference> {
  readonly #modules: ReadonlyMap<Reference, unknown>;

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
    this.#modules = new Map(modules);
  }

  load(reference: Reference, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.#modules.has(reference)) throw new TypeError("Unknown module reference");
    return this.#modules.get(reference);
  }
}
