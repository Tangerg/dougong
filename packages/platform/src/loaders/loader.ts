export interface Loader<Reference> {
  readonly load: (reference: Reference, signal: AbortSignal) => unknown;
}

// Same-realm imports provide no isolation; authorization cannot constrain admitted code.
export class ImportLoader implements Loader<string | URL> {
  readonly load = async (reference: string | URL, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const module = await import(/* @vite-ignore */ String(reference));
    signal.throwIfAborted();
    return module;
  };
}

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
