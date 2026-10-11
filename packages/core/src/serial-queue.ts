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
    // Observe failure on the tail without propagating it so one rejected command cannot poison the next.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
