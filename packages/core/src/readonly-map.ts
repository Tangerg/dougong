/**
 * A structural snapshot that exposes no mutating Map methods.
 *
 * `ReadonlyMap` is only a compile-time view — casting a live `Map` to it still
 * hands out an object whose `set` and `delete` are one cast away. This copies on
 * construction and freezes itself, so a published snapshot cannot be edited by
 * whoever received it, and cannot change under a reader afterwards.
 */
export class ReadonlyMapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value> | Iterable<readonly [Key, Value]> = []) {
    if (
      !values ||
      (typeof values !== "object" && typeof values !== "function") ||
      typeof values[Symbol.iterator] !== "function"
    ) {
      throw new TypeError("ReadonlyMapSnapshot values must be an iterable object");
    }
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size() {
    return this.#values.size;
  }

  get(key: Key) {
    return this.#values.get(key);
  }

  has(key: Key) {
    return this.#values.has(key);
  }

  forEach(
    callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ) {
    for (const [key, value] of this.#values) callback.call(thisArg, value, key, this);
  }

  entries() {
    return this.#values.entries();
  }

  keys() {
    return this.#values.keys();
  }

  values() {
    return this.#values.values();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}
