import type { ResolvedValue } from "dougong";
import { onAbort, resolveValue } from "dougong/advanced";

interface Waiter<T> {
  resolve: (value: ResolvedValue<T>) => void;
  reject: (reason: unknown) => void;
}

type PreparationState<T> =
  | { readonly controller: AbortController; readonly waiters: Set<Waiter<T>> }
  | "settled"
  | "cancelled";

export class Preparation<T> {
  #state: PreparationState<T>;
  readonly result: Promise<ResolvedValue<T>>;

  private constructor(result: Promise<ResolvedValue<T>>, controller: AbortController) {
    this.#state = { controller, waiters: new Set() };
    this.result = result;
    // One reaction per preparation; a cancelled waiter detaches even when external work never settles.
    void result.then(
      (value) => this.#settle((waiter) => waiter.resolve(value)),
      (error) => this.#settle((waiter) => waiter.reject(error)),
    );
  }

  static start<T>(run: (signal: AbortSignal) => T | PromiseLike<T>) {
    const controller = new AbortController();
    return new Preparation(
      Promise.resolve().then(() => {
        AbortSignal.prototype.throwIfAborted.call(controller.signal);
        return resolveValue(run(controller.signal));
      }),
      controller,
    );
  }

  // The adapter receives its own signal, never the private signal that detaches its waiter.
  static waitFor<T>(
    run: (signal: AbortSignal) => T | PromiseLike<T>,
    parent: AbortSignal,
  ): Promise<ResolvedValue<Awaited<T>>> {
    const controller = new AbortController();
    const work = Promise.withResolvers<ResolvedValue<Awaited<T>>>();
    const waiter = new Preparation(work.promise, controller).wait(parent);
    try {
      void resolveValue(run(controller.signal)).then(work.resolve, work.reject);
    } catch (error) {
      work.reject(error);
    }
    return waiter;
  }

  get cancelled() {
    return this.#state === "cancelled";
  }

  wait(signal: AbortSignal): Promise<ResolvedValue<T>> {
    AbortSignal.prototype.throwIfAborted.call(signal);
    const state = this.#state;
    if (state === "settled") return this.result;
    if (state === "cancelled") throw new TypeError("Cannot join a cancelled preparation");
    const { promise, resolve, reject } = Promise.withResolvers<ResolvedValue<T>>();
    const waiter = { resolve, reject };
    state.waiters.add(waiter);
    const detach = onAbort(signal, (reason) => {
      if (!state.waiters.delete(waiter)) return;
      if (!state.waiters.size) {
        this.#state = "cancelled";
        state.controller.abort();
      }
      reject(reason);
    });
    return promise.finally(detach);
  }

  #settle(complete: (waiter: Waiter<T>) => void) {
    const state = this.#state;
    if (typeof state === "string") return;
    this.#state = "settled";
    for (const waiter of state.waiters) complete(waiter);
    state.waiters.clear();
  }
}
