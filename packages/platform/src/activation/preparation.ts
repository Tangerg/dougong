import { onAbort } from "dougong/advanced";

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class Preparation<T> {
  readonly #controller = new AbortController();
  readonly result: Promise<T>;
  #waiters: Set<Waiter<T>> | undefined = new Set();

  constructor(run: (signal: AbortSignal) => T | PromiseLike<T>) {
    this.result = Promise.resolve().then(() => {
      AbortSignal.prototype.throwIfAborted.call(this.#controller.signal);
      return run(this.#controller.signal);
    });
    // One reaction per preparation; a cancelled waiter detaches even when external work never settles.
    void this.result.then(
      (value) => this.#settle((waiter) => waiter.resolve(value)),
      (error) => this.#settle((waiter) => waiter.reject(error)),
    );
  }

  get cancelled() {
    // External preparation code receives this signal, not authority to replace its state.
    return Reflect.get(AbortSignal.prototype, "aborted", this.#controller.signal) as boolean;
  }

  wait(signal: AbortSignal): Promise<T> {
    AbortSignal.prototype.throwIfAborted.call(signal);
    AbortSignal.prototype.throwIfAborted.call(this.#controller.signal);
    const waiters = this.#waiters;
    if (!waiters) return this.result;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const waiter = { resolve, reject };
    waiters.add(waiter);
    const detach = onAbort(signal, (reason) => {
      if (!waiters.delete(waiter)) return;
      if (!waiters.size) this.#controller.abort();
      reject(reason);
    });
    return promise.finally(detach);
  }

  #settle(complete: (waiter: Waiter<T>) => void) {
    const waiters = this.#waiters!;
    this.#waiters = undefined;
    for (const waiter of waiters) complete(waiter);
    waiters.clear();
  }
}
