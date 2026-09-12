import { ReadonlyMapSnapshot, SnapshotPublisher, type SnapshotView } from "@dougongjs/core";
import type { Manifest } from "./manifest";

export type PlatformStatus = "active" | "disposing" | "disposed";

/**
 * `registered` and `installed` are the distinction the whole Platform exists to
 * make: admitted, versus loaded and committed as a Core Installation. Only
 * `ready()` establishes execution readiness. `loading` is visible in
 * between so a slow import is observable rather than looking like a hang.
 */
export type RegistrationStatus =
  "pending" | "registered" | "loading" | "installed" | "failed" | "removed";

export interface RegistrationSnapshot {
  readonly manifestName: string;
  readonly version: string;
  readonly status: RegistrationStatus;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly error?: Error;
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

/**
 * Immutable operational read model compiled to Core's snapshot protocol.
 *
 * Built on Core's `SnapshotPublisher` rather than a second observation mechanism,
 * so a consumer subscribes to Platform and Host diagnostics the same way.
 */
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
