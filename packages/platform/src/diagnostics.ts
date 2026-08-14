import { ReadonlyMapSnapshot, SnapshotPublisher, type SnapshotView } from "@dougong/core";
import type { PluginManifest } from "./manifest";

export type PluginPlatformStatus = "active" | "disposing" | "disposed";
export type ManagedPluginStatus =
  "pending" | "registered" | "loading" | "activated" | "failed" | "removed";

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

/** Immutable operational read model compiled to Core's snapshot protocol. */
export class PlatformDiagnostics {
  readonly #apiVersion: string;
  readonly #source: SnapshotPublisher<PluginPlatformSnapshot>;
  #revision = 0;
  #snapshot: PluginPlatformSnapshot;

  readonly view: SnapshotView<PluginPlatformSnapshot>;

  constructor(apiVersion: string, report: (error: unknown) => void) {
    this.#apiVersion = apiVersion;
    this.#snapshot = this.#createSnapshot("active", []);
    this.#source = new SnapshotPublisher(() => this.#snapshot, report);
    this.view = this.#source.view;
  }

  publish(status: PluginPlatformStatus, plugins: Iterable<DiagnosablePlugin>) {
    this.#revision++;
    this.#snapshot = this.#createSnapshot(status, plugins);
    this.#source.invalidate();
  }

  dispose() {
    this.#source.dispose();
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
      const error = plugin.error;
      snapshots.set(
        manifest.name,
        Object.freeze(
          error === undefined ? snapshot : { ...snapshot, error },
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
