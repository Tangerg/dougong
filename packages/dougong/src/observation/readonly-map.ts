// ReadonlyMap alone leaves runtime mutators reachable; snapshots must own their data and expose no mutators.
export class ReadonlyMapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value> | Iterable<readonly [Key, Value]> = []) {
    if (!values || (typeof values !== "object" && typeof values !== "function")) {
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
    receiver?: unknown,
  ) {
    if (typeof callback !== "function")
      throw new TypeError("ReadonlyMapSnapshot callback must be a function");
    for (const [key, value] of this.#values) Reflect.apply(callback, receiver, [value, key, this]);
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
