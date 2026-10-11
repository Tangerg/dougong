import {
  ReadonlyMapSnapshot,
  RecordedFailure,
  SnapshotPublisher,
  type SnapshotView,
} from "@dougongjs/core";
import type { Manifest } from "./manifest";

export type PlatformStatus = "active" | "disposing" | "disposed";

export type RegistrationStatus =
  "pending" | "registered" | "loading" | "installed" | "unavailable" | "failed" | "removed";

export interface RegistrationSnapshot {
  readonly manifestName: string;
  readonly version: string;
  readonly status: RegistrationStatus;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly error?: RecordedFailure;
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
  readonly error: Error | undefined;
}

// Reuse Core snapshot publication so Platform does not introduce a second observation mechanism.
export class PlatformDiagnostics {
  readonly #apiVersion: string;
  readonly #publisher: SnapshotPublisher<PlatformSnapshot>;
  #revision = 0;

  readonly view: SnapshotView<PlatformSnapshot>;

  constructor(
    apiVersion: string,
    read: () => {
      readonly status: PlatformStatus;
      readonly registrations: Iterable<DiagnosableRegistration>;
    },
    report: (error: unknown) => void,
  ) {
    this.#apiVersion = apiVersion;
    this.#publisher = new SnapshotPublisher(() => {
      const { status, registrations } = read();
      return this.#createSnapshot(status, registrations);
    }, report);
    this.view = this.#publisher.view;
  }

  publish() {
    this.#revision++;
    this.#publisher.invalidate();
  }

  dispose() {
    this.#publisher.dispose();
  }

  #createSnapshot(status: PlatformStatus, registrations: Iterable<DiagnosableRegistration>) {
    const snapshots = new Map<string, RegistrationSnapshot>();
    for (const registration of registrations) {
      const { manifest } = registration;
      const snapshot = {
        manifestName: manifest.name,
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
          error === undefined ? snapshot : { ...snapshot, error: new RecordedFailure(error) },
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
