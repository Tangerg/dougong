import { isAborted, onAbort } from "./abort.js";
import { resolveValue, type ResolvedValue } from "./async-result.js";

export class SerialQueue {
  readonly #pending = new Set<() => Promise<void>>();
  #draining = false;

  // A barrier observes only the commands already submitted, even if another command arrives later.
  settled(): Promise<void> {
    return this.run(() => undefined).then(() => undefined);
  }

  run<T>(
    operation: () => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<ResolvedValue<Awaited<T>>> {
    if (typeof operation !== "function") {
      throw new TypeError("SerialQueue operation must be a function");
    }
    const result = Promise.withResolvers<ResolvedValue<Awaited<T>>>();
    const settled = result.promise.then(
      () => undefined,
      () => undefined,
    );
    const start = () => {
      detach?.();
      try {
        void resolveValue(operation()).then(result.resolve, result.reject);
      } catch (error) {
        result.reject(error);
      }
      return settled;
    };
    const detach =
      signal === undefined
        ? undefined
        : onAbort(signal, (reason) => {
            this.#pending.delete(start);
            result.reject(reason);
          });
    if (signal !== undefined && isAborted(signal)) return result.promise;
    this.#pending.add(start);
    if (!this.#draining) {
      this.#draining = true;
      queueMicrotask(() => void this.#drain());
    }
    return result.promise;
  }

  async #drain() {
    for (const start of this.#pending) {
      this.#pending.delete(start);
      await start();
    }
    this.#draining = false;
  }
}
