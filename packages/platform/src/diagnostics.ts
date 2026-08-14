import type { Disposable, SnapshotView } from "@dougong/core";
import type { PluginManifest } from "./manifest";

export type PluginPlatformStatus = "active" | "disposing" | "disposed";
export type ManagedPluginStatus =
  "pending" | "registered" | "loading" | "active" | "failed" | "removed";

export interface ManagedPluginSnapshot {
  readonly name: string;
  readonly version: string;
  readonly status: ManagedPluginStatus;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly error?: unknown;
}

export interface PluginPlatformSnapshot {
  readonly apiVersion: string;
  readonly status: PluginPlatformStatus;
  readonly revision: number;
  readonly plugins: ReadonlyMap<string, ManagedPluginSnapshot>;
}

export interface DiagnosablePlugin {
  readonly manifest: PluginManifest;
  readonly status: ManagedPluginStatus;
  readonly error: unknown;
}

interface PlatformSubscriptionState {
  owner: PlatformDiagnostics | undefined;
  listener: (() => void) | undefined;
}

const platformSubscriptionStates = new WeakMap<PlatformSubscription, PlatformSubscriptionState>();

/** Immutable operational read model with the same get/subscribe protocol as Core. */
export class PlatformDiagnostics {
  readonly #apiVersion: string;
  readonly #subscriptions = new Set<PlatformSubscription>();
  #report: ((error: unknown) => void) | undefined;
  #closed = false;
  #revision = 0;
  #snapshot: PluginPlatformSnapshot;

  readonly view: SnapshotView<PluginPlatformSnapshot>;

  constructor(apiVersion: string, report: (error: unknown) => void) {
    this.#apiVersion = apiVersion;
    this.#report = report;
    this.#snapshot = this.#createSnapshot("active", []);
    this.view = Object.freeze({
      get: () => this.#snapshot,
      subscribe: (listener: () => void): Disposable => {
        if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
        if (this.#closed) throw new TypeError("Platform diagnostics have been closed");
        const subscription = new PlatformSubscription(this, listener);
        this.#subscriptions.add(subscription);
        return subscription;
      },
    });
  }

  publish(status: PluginPlatformStatus, plugins: Iterable<DiagnosablePlugin>) {
    this.#revision++;
    this.#snapshot = this.#createSnapshot(status, plugins);
    for (const subscription of [...this.#subscriptions]) {
      try {
        notifyPlatformSubscription(subscription);
      } catch (error) {
        this.#report?.(error);
      }
    }
  }

  remove(subscription: PlatformSubscription) {
    this.#subscriptions.delete(subscription);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#report = undefined;
    const subscriptions = [...this.#subscriptions];
    this.#subscriptions.clear();
    for (const subscription of subscriptions) closePlatformSubscription(subscription);
  }

  #createSnapshot(status: PluginPlatformStatus, plugins: Iterable<DiagnosablePlugin>) {
    const snapshots = new Map<string, ManagedPluginSnapshot>();
    for (const plugin of plugins) {
      const { manifest } = plugin;
      const snapshot = {
        name: manifest.name,
        version: manifest.version,
        status: plugin.status,
        activation: manifest.activation,
        permissions: manifest.permissions,
        dependencies: manifest.dependencies,
      };
      snapshots.set(
        manifest.name,
        Object.freeze(
          plugin.error === undefined ? snapshot : { ...snapshot, error: plugin.error },
        ) as ManagedPluginSnapshot,
      );
    }

    return Object.freeze({
      apiVersion: this.#apiVersion,
      status,
      revision: this.#revision,
      plugins: new ReadonlyMapSnapshot(snapshots),
    });
  }
}

class PlatformSubscription implements Disposable {
  constructor(owner: PlatformDiagnostics, listener: () => void) {
    platformSubscriptionStates.set(this, { owner, listener });
    Object.freeze(this);
  }

  dispose() {
    const state = platformSubscriptionStates.get(this);
    if (!state?.owner) return;
    const owner = state.owner;
    closePlatformSubscription(this);
    owner.remove(this);
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

function notifyPlatformSubscription(subscription: PlatformSubscription) {
  platformSubscriptionStates.get(subscription)?.listener?.();
}

function closePlatformSubscription(subscription: PlatformSubscription) {
  const state = platformSubscriptionStates.get(subscription);
  if (!state) return;
  state.owner = undefined;
  state.listener = undefined;
  platformSubscriptionStates.delete(subscription);
}

class ReadonlyMapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: Iterable<readonly [Key, Value]>) {
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
