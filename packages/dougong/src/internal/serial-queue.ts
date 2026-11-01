import { isAborted, onAbort } from "./abort.js";

export class SerialQueue {
  readonly #pending = new Set<() => Promise<void>>();
  #draining = false;

  get settled() {
    // A barrier observes only the commands already submitted, even if another command arrives later.
    return this.run(() => undefined);
  }

  run<T>(operation: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (typeof operation !== "function") {
      throw new TypeError("SerialQueue operation must be a function");
    }
    const result = Promise.withResolvers<T>();
    const settled = result.promise.then(
      () => undefined,
      () => undefined,
    );
    const start = () => {
      detach?.();
      try {
        result.resolve(operation());
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
