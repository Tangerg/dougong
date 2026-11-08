import type { ResolvedValue } from "dougong";
import { onAbort, resolveValue } from "dougong/advanced";

class OperationWait<T> {
  #waiting:
    | {
        readonly resolve: (value: ResolvedValue<Awaited<T>>) => void;
        readonly reject: (reason: unknown) => void;
        detach?: () => void;
      }
    | undefined;

  constructor(
    signal: AbortSignal,
    resolve: (value: ResolvedValue<Awaited<T>>) => void,
    reject: (reason: unknown) => void,
  ) {
    this.#waiting = { resolve, reject };
    const detach = onAbort(signal, (reason) => this.reject(reason));
    if (this.#waiting) this.#waiting.detach = detach;
    else detach();
  }

  observe(result: PromiseLike<T>) {
    // Late results retain only this detachable waiter, never the caller's signal or start closure.
    void resolveValue(result).then(
      (value) => this.#take()?.resolve(value),
      (error: unknown) => this.reject(error),
    );
  }

  reject(reason: unknown) {
    this.#take()?.reject(reason);
  }

  #take() {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.detach?.();
    return waiting;
  }
}

// Only abandon operations whose late values and failures are safe to ignore.
export function abandonOnAbort<T>(
  signal: AbortSignal,
  start: () => PromiseLike<T>,
): Promise<ResolvedValue<Awaited<T>>> {
  return new Promise<ResolvedValue<Awaited<T>>>((resolve, reject) => {
    const waiter = new OperationWait<T>(signal, resolve, reject);

    void Promise.resolve()
      .then(() => {
        // A separate start reaction would allow abort to arrive after the check.
        AbortSignal.prototype.throwIfAborted.call(signal);
        waiter.observe(start());
      })
      .catch((error: unknown) => waiter.reject(error));
  });
}
