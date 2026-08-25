/**
 * Serial execution where each caller keeps its own result and failures do not
 * poison the tail.
 *
 * This is the Host's command boundary: one queue is the reason two concurrent
 * `install()` calls cannot interleave their transactions.
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  get settled() {
    return this.#tail;
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (typeof operation !== "function") {
      throw new TypeError("SerialQueue operation must be a function");
    }
    const result = this.#tail.then(operation);
    // The queue advances on a branch that swallows the outcome, while `result`
    // keeps it. One caller's rejection therefore delays the next operation
    // without failing it, and the error still surfaces to whoever called `run`.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
