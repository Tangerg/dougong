import { ReadonlyMapSnapshot, SnapshotPublisher, type SnapshotView } from "@dougongjs/core";
import type { Manifest } from "./manifest";

export type PlatformStatus = "active" | "disposing" | "disposed";
export type RegistrationStatus =
  "pending" | "registered" | "loading" | "activated" | "failed" | "removed";

export interface RegistrationSnapshot {
  readonly name: string;
  readonly version: string;
  readonly status: RegistrationStatus;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly error?: unknown;
}

export interface PlatformSnapshot {
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly revision: number;
  readonly registrations: ReadonlyMap<string, RegistrationSnapshot>;
}

export interface DiagnosableRegistration {
  readonly manifest: Manifest;
  readonly status: RegistrationStatus;
  readonly error: unknown;
}

/** Immutable operational read model compiled to Core's snapshot protocol. */
export class PlatformDiagnostics {
  readonly #apiVersion: string;
  readonly #source: SnapshotPublisher<PlatformSnapshot>;
  #revision = 0;
  #snapshot: PlatformSnapshot;

  readonly view: SnapshotView<PlatformSnapshot>;

  constructor(apiVersion: string, report: (error: unknown) => void) {
    this.#apiVersion = apiVersion;
    this.#snapshot = this.#createSnapshot("active", []);
    this.#source = new SnapshotPublisher(() => this.#snapshot, report);
    this.view = this.#source.view;
  }

  publish(status: PlatformStatus, registrations: Iterable<DiagnosableRegistration>) {
    this.#revision++;
    this.#snapshot = this.#createSnapshot(status, registrations);
    this.#source.invalidate();
  }

  dispose() {
    this.#source.dispose();
  }

  #createSnapshot(status: PlatformStatus, registrations: Iterable<DiagnosableRegistration>) {
    const snapshots = new Map<string, RegistrationSnapshot>();
    for (const registration of registrations) {
      const { manifest } = registration;
      const snapshot = {
        name: manifest.name,
        version: manifest.version,
        status: registration.status,
        activation: manifest.activation,
        permissions: manifest.permissions,
        dependencies: manifest.dependencies,
      };
      const error = registration.error;
      snapshots.set(
        manifest.name,
        Object.freeze(
          error === undefined ? snapshot : { ...snapshot, error },
        ) as RegistrationSnapshot,
      );
    }

    return Object.freeze({
      apiVersion: this.#apiVersion,
      status,
      revision: this.#revision,
      registrations: new ReadonlyMapSnapshot(snapshots),
    });
  }
}
