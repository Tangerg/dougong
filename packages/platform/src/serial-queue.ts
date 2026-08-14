/** Serial execution where each caller keeps its own result and failures do not poison the tail. */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  get settled() {
    return this.#tail;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
