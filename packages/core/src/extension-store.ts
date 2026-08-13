import { signal, type Disposable, type Readable, type Signal } from "@dougong/reactive";

export interface ExtensionView<T> extends Readable<ReadonlyMap<string, T>> {}

export interface Contribution<T> extends Disposable {
  update(value: T): void;
}

class MapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values?: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
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
    for (const [key, value] of this.#values) {
      callback.call(thisArg, value, key, this);
    }
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

export class ExtensionStore<T> implements ExtensionView<T> {
  readonly #entries = new Map<string, T>();
  readonly #snapshot: Signal<ReadonlyMap<string, T>> = signal(new MapSnapshot());

  get() {
    return this.#snapshot.get();
  }

  subscribe(listener: () => void) {
    return this.#snapshot.subscribe(listener);
  }

  contribute(key: string, initialValue: T): Contribution<T> {
    if (typeof key !== "string" || !key.trim()) {
      throw new TypeError("Contribution key must be a non-empty string");
    }
    if (key !== key.trim()) {
      throw new TypeError("Contribution key cannot start or end with whitespace");
    }
    if (this.#entries.has(key)) {
      throw new TypeError(`Duplicate extension contribution '${key}'`);
    }

    let active = true;
    this.#entries.set(key, initialValue);
    this.#publish();

    return {
      update: (value) => {
        if (!active) throw new TypeError(`Contribution '${key}' has been disposed`);
        if (Object.is(this.#entries.get(key), value)) return;
        this.#entries.set(key, value);
        this.#publish();
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.#entries.delete(key);
        this.#publish();
      },
    };
  }

  #publish() {
    this.#snapshot.set(new MapSnapshot(this.#entries));
  }
}
