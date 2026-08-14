/** Serial execution where each caller keeps its own result and failures do not poison the tail. */
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
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
