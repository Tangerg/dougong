export interface Loader<Reference> {
  readonly load: (reference: Reference, signal: AbortSignal) => unknown;
}

// Same-realm imports provide no isolation; authorization cannot constrain admitted code.
export class ImportLoader implements Loader<string> {
  readonly load = async (reference: string, signal: AbortSignal): Promise<unknown> => {
    AbortSignal.prototype.throwIfAborted.call(signal);
    if (typeof reference !== "string")
      throw new TypeError("ImportLoader reference must be a string");
    const module = await import(/* @vite-ignore */ reference);
    AbortSignal.prototype.throwIfAborted.call(signal);
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
      typeof modules.has !== "function"
    ) {
      throw new TypeError("MemoryLoader modules must be a ReadonlyMap");
    }
    this.#modules = new Map<unknown, unknown>(modules);
  }

  readonly load = (reference: Reference, signal: AbortSignal) => {
    AbortSignal.prototype.throwIfAborted.call(signal);
    if (!this.#modules.has(reference)) throw new TypeError("Unknown module reference");
    return this.#modules.get(reference);
  };
}
