import type { Extension } from "./contracts";
import { ReadonlyMapSnapshot } from "./readonly-map";
import type { Disposable, Publication, StagedResource } from "./resource";

export interface Contribution<T> extends Disposable {
  update(value: T): void;
}

export interface ExtensionView<T> {
  get(): ReadonlyMap<string, T>;
  subscribe(listener: () => void): Disposable;
}

export type ExtensionLeaseKind = "view" | "subscription";

interface ExtensionViewState<T> {
  store: ExtensionStore<T> | undefined;
  own: ((resource: Disposable, kind: ExtensionLeaseKind) => () => void) | undefined;
}

class ContributionHandle<T> implements Contribution<T> {
  readonly #record: ContributionRecord<T>;

  constructor(record: ContributionRecord<T>) {
    this.#record = record;
    Object.freeze(this);
  }

  update(value: T) {
    this.#record.update(value);
  }

  dispose() {
    this.#record.dispose();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

class ContributionRecord<T> implements StagedResource<Contribution<T>> {
  #state: "staged" | "published" | "disposed" = "staged";
  #store: ExtensionStore<T> | undefined;
  readonly #id: string;
  #value: T | undefined;
  #release: ((publication: Publication) => void) | undefined;
  readonly handle: Contribution<T>;

  constructor(
    store: ExtensionStore<T>,
    id: string,
    initialValue: T,
    release: (publication: Publication) => void,
  ) {
    this.#store = store;
    this.#id = id;
    this.#value = initialValue;
    this.#release = release;
    this.handle = new ContributionHandle(this);
  }

  publish() {
    if (this.#state !== "staged") return;
    this.#store!.insert(this.#id, this, this.#value as T);
    this.#state = "published";
  }

  update(value: T) {
    if (this.#state === "disposed") {
      throw new TypeError(`Contribution '${this.#id}' has been disposed`);
    }
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    if (this.#state === "published") this.#store!.update(this.#id, this, value);
  }

  dispose() {
    if (this.#state === "disposed") return;
    const published = this.#state === "published";
    this.#state = "disposed";
    try {
      this.#store!.release(this.#id, this, published);
    } finally {
      this.#store = undefined;
      this.#value = undefined;
      const release = this.#release;
      this.#release = undefined;
      release?.(this);
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ExtensionStore<T> {
  readonly #dirty: (store: ExtensionStore<unknown>) => void;
  readonly #report: (error: unknown) => void;
  readonly #claims = new Map<string, ContributionRecord<T>>();
  readonly #entries = new Map<string, { record: ContributionRecord<T>; value: T }>();
  readonly #listeners = new Set<() => void>();
  #snapshot: ReadonlyMap<string, T> = new ReadonlyMapSnapshot();

  constructor(dirty: (store: ExtensionStore<unknown>) => void, report: (error: unknown) => void) {
    this.#dirty = dirty;
    this.#report = report;
  }

  stage(
    ownerId: string,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ): ContributionRecord<T> {
    validateKey(key);
    const id = `${ownerId}/${key}`;
    if (this.#claims.has(id)) {
      throw new TypeError(`Duplicate extension contribution '${id}'`);
    }
    const contribution = new ContributionRecord(this, id, value, release);
    this.#claims.set(id, contribution);
    return contribution;
  }

  view(own: (resource: Disposable, kind: ExtensionLeaseKind) => () => void): ExtensionView<T> {
    const state: ExtensionViewState<T> = { store: this, own };
    let releaseView: (() => void) | undefined;
    const lease = new ExtensionViewLease(state, () => {
      const release = releaseView;
      releaseView = undefined;
      release?.();
    });
    releaseView = own(lease, "view");
    return Object.freeze({
      get: () => {
        const store = state.store;
        if (!store) throw new TypeError("Extension view has been disposed");
        return store.#snapshot;
      },
      subscribe: (listener: () => void) => {
        if (typeof listener !== "function") {
          throw new TypeError("Extension subscriber must be a function");
        }
        const store = state.store;
        const ownResource = state.own;
        if (!store || !ownResource) throw new TypeError("Extension view has been disposed");
        let releaseFromOwner: (() => void) | undefined;
        const subscription = new ExtensionSubscription(store, listener, () => {
          const release = releaseFromOwner;
          releaseFromOwner = undefined;
          release?.();
        });
        releaseFromOwner = ownResource(subscription, "subscription");
        store.#listeners.add(listener);
        return subscription;
      },
    });
  }

  insert(id: string, record: ContributionRecord<T>, value: T) {
    if (this.#claims.get(id) !== record || this.#entries.has(id)) {
      throw new TypeError(`Duplicate extension contribution '${id}'`);
    }
    this.#entries.set(id, { record, value });
    this.#dirty(this as ExtensionStore<unknown>);
  }

  update(id: string, record: ContributionRecord<T>, value: T) {
    const entry = this.#entries.get(id);
    if (entry?.record !== record) return;
    entry.value = value;
    this.#dirty(this as ExtensionStore<unknown>);
  }

  release(id: string, record: ContributionRecord<T>, published: boolean) {
    if (this.#claims.get(id) === record) this.#claims.delete(id);
    if (!published || this.#entries.get(id)?.record !== record) return;
    this.#entries.delete(id);
    this.#dirty(this as ExtensionStore<unknown>);
  }

  flush() {
    const nextEntries = [...this.#entries].map(([key, entry]) => [key, entry.value] as const);
    const unchanged =
      nextEntries.length === this.#snapshot.size &&
      nextEntries.every(([key, value]) => Object.is(this.#snapshot.get(key), value));
    if (unchanged) return;

    this.#snapshot = new ReadonlyMapSnapshot(nextEntries);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#report(error);
      }
    }
  }

  removeListener(listener: () => void) {
    this.#listeners.delete(listener);
  }
}

class ExtensionViewLease<T> implements Disposable {
  #state: ExtensionViewState<T> | undefined;
  #release: (() => void) | undefined;

  constructor(state: ExtensionViewState<T>, release: () => void) {
    this.#state = state;
    this.#release = release;
    Object.freeze(this);
  }

  dispose() {
    const state = this.#state;
    if (!state) return;
    this.#state = undefined;
    state.store = undefined;
    state.own = undefined;
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

class ExtensionSubscription<T> implements Disposable {
  #store: ExtensionStore<T> | undefined;
  #listener: (() => void) | undefined;
  #release: (() => void) | undefined;

  constructor(store: ExtensionStore<T>, listener: () => void, release: () => void) {
    this.#store = store;
    this.#listener = listener;
    this.#release = release;
    Object.freeze(this);
  }

  dispose() {
    const store = this.#store;
    if (!store) return;
    const listener = this.#listener!;
    this.#store = undefined;
    this.#listener = undefined;
    try {
      store.removeListener(listener);
    } finally {
      const release = this.#release;
      this.#release = undefined;
      release?.();
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ExtensionRegistry {
  readonly #stores = new Map<string, ExtensionStore<unknown>>();
  readonly #dirty = new Set<ExtensionStore<unknown>>();
  readonly #report: (error: unknown) => void;
  #batchDepth = 0;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  get<T>(_token: Extension<T>): ExtensionStore<T> {
    const current = this.#stores.get(_token.id);
    if (current) return current as ExtensionStore<T>;
    const store = new ExtensionStore<T>((item) => this.#markDirty(item), this.#report);
    this.#stores.set(_token.id, store as ExtensionStore<unknown>);
    return store;
  }

  beginBatch() {
    this.#batchDepth++;
  }

  endBatch() {
    if (!this.#batchDepth) throw new TypeError("Extension batch is not active");
    this.#batchDepth--;
    if (this.#batchDepth) return;
    const stores = [...this.#dirty];
    this.#dirty.clear();
    for (const store of stores) store.flush();
  }

  #markDirty(store: ExtensionStore<unknown>) {
    this.#dirty.add(store);
    if (this.#batchDepth) return;
    this.#dirty.delete(store);
    store.flush();
  }
}

function validateKey(key: string) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Contribution key must be a non-empty string");
  }
  if (key !== key.trim()) {
    throw new TypeError("Contribution key cannot start or end with whitespace");
  }
}

export type ExtensionRequirementView<T> =
  T extends Extension<infer Value> ? ExtensionView<Value> : never;
