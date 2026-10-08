import type { GroupNode } from "./group";
import type { InstallationRecord, InstallationSnapshot } from "./installation";
import { ReadonlyMapSnapshot } from "./readonly-map";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

/**
 * `changing` is the reason the read window is closed during a transaction.
 * `host.get()` only answers while the status is `active`, so a Service lookup
 * mid-change cannot observe a half-applied plan — it fails instead.
 */
export type HostStatus = "idle" | "starting" | "active" | "changing" | "stopping";

export type { InstallationSnapshot } from "./installation";

export interface GroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
}

export interface HostSnapshot {
  readonly name: string;
  readonly status: HostStatus;
  readonly revision: number;
  readonly installations: ReadonlyMap<string, InstallationSnapshot>;
  readonly groups: ReadonlyMap<string, GroupSnapshot>;
}

interface HostDiagnosticSource {
  readonly status: HostStatus;
  readonly installations: Iterable<InstallationRecord>;
  readonly groups: Iterable<GroupNode>;
}

/**
 * Immutable operational read model; never a service locator or control plane.
 *
 * Everything here is data or another read-only view. There is deliberately no
 * way back: nothing in a snapshot can install, remove, or reach a live Instance.
 * `revision` increments on every publish so a consumer can tell "nothing
 * changed" from "changed back to an equal value".
 */
export class HostDiagnostics {
  readonly #name: string;
  readonly #publisher: SnapshotPublisher<HostSnapshot>;
  #revision = 0;

  readonly view: SnapshotView<HostSnapshot>;

  constructor(name: string, read: () => HostDiagnosticSource, report: (error: unknown) => void) {
    this.#name = name;
    this.#publisher = new SnapshotPublisher(() => {
      const { status, installations, groups } = read();
      return this.#createSnapshot(status, installations, groups);
    }, report);
    this.view = this.#publisher.view;
  }

  publish() {
    this.#revision++;
    this.#publisher.invalidate();
  }

  #createSnapshot(
    status: HostStatus,
    records: Iterable<InstallationRecord>,
    groupNodes: Iterable<GroupNode>,
  ) {
    const installations = new Map<string, InstallationSnapshot>();
    for (const installation of records) {
      installations.set(installation.id, installation.diagnostics.get());
    }

    const groups = new Map<string, GroupSnapshot>();
    for (const group of groupNodes) {
      const base = { id: group.id, name: group.name };
      groups.set(
        group.id,
        Object.freeze(group.parent ? { ...base, parentId: group.parent.id } : base),
      );
    }

    return Object.freeze({
      name: this.#name,
      status,
      revision: this.#revision,
      installations: new ReadonlyMapSnapshot(installations),
      groups: new ReadonlyMapSnapshot(groups),
    });
  }
}
