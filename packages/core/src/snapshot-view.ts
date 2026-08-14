import type { Disposable } from "./resource";

export interface SnapshotView<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

/** Small synchronous observable used for operational read models, not reactivity. */
export class SnapshotPublisher<T> implements SnapshotView<T> {
  readonly #listeners = new Set<() => void>();
  readonly #report: (error: unknown) => void;
  readonly #read: () => T;
  #snapshot: T;
  #dirty = false;

  constructor(read: () => T, report: (error: unknown) => void) {
    this.#read = read;
    this.#snapshot = read();
    this.#report = report;
  }

  readonly view: SnapshotView<T> = Object.freeze({
    get: () => this.get(),
    subscribe: (listener: () => void) => this.subscribe(listener),
  });

  get() {
    if (this.#dirty) {
      this.#snapshot = this.#read();
      this.#dirty = false;
    }
    return this.#snapshot;
  }

  subscribe(listener: () => void): Disposable {
    if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
    this.#listeners.add(listener);
    return new SnapshotSubscription(this, listener);
  }

  invalidate() {
    this.#dirty = true;
    if (!this.#listeners.size) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#report(error);
      }
    }
  }

  remove(listener: () => void) {
    this.#listeners.delete(listener);
  }
}

class SnapshotSubscription<T> implements Disposable {
  #publisher: SnapshotPublisher<T> | undefined;
  #listener: (() => void) | undefined;

  constructor(publisher: SnapshotPublisher<T>, listener: () => void) {
    this.#publisher = publisher;
    this.#listener = listener;
    Object.freeze(this);
  }

  dispose() {
    const publisher = this.#publisher;
    if (!publisher) return;
    const listener = this.#listener!;
    this.#publisher = undefined;
    this.#listener = undefined;
    publisher.remove(listener);
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}
