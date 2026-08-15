/** A structural snapshot that exposes no mutating Map methods. */
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
