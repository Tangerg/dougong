import type { GroupNode } from "./group";
import type { InstallationRecord } from "./installation";
import type { LifetimeSnapshot } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import { ReadonlyMapSnapshot } from "./readonly-map";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export type HostStatus = "idle" | "starting" | "active" | "changing" | "stopping";

export interface InstallationSnapshot {
  readonly id: string;
  readonly pluginName: string;
  readonly groupId: string;
  readonly status: LifecycleStatus;
  readonly requires: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly lifetime?: SnapshotView<LifetimeSnapshot>;
  readonly error?: Error;
}

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

/** Immutable operational read model; never a service locator or control plane. */
export class HostDiagnostics {
  readonly #name: string;
  readonly #publisher: SnapshotPublisher<HostSnapshot>;
  #snapshot: HostSnapshot;
  #revision = 0;

  readonly view: SnapshotView<HostSnapshot>;

  constructor(name: string, groups: Iterable<GroupNode>, report: (error: unknown) => void) {
    this.#name = name;
    this.#snapshot = this.#createSnapshot("idle", [], groups);
    this.#publisher = new SnapshotPublisher(() => this.#snapshot, report);
    this.view = this.#publisher.view;
  }

  publish(
    status: HostStatus,
    installations: Iterable<InstallationRecord>,
    groups: Iterable<GroupNode>,
  ) {
    this.#revision++;
    this.#snapshot = this.#createSnapshot(status, installations, groups);
    this.#publisher.invalidate();
  }

  #createSnapshot(
    status: HostStatus,
    records: Iterable<InstallationRecord>,
    groupNodes: Iterable<GroupNode>,
  ) {
    const installations = new Map<string, InstallationSnapshot>();
    for (const installation of records) {
      const base = {
        id: installation.id,
        pluginName: installation.declaration.plugin.name,
        groupId: installation.groupId,
        status: installation.status,
        requires: Object.freeze(
          Object.values(installation.declaration.plugin.requires ?? {}).map((requirement) => {
            return requirement.kind === "optional" ? requirement.service.id : requirement.id;
          }),
        ),
        provides: Object.freeze(
          Object.values(installation.declaration.plugin.provides ?? {}).map((token) => token.id),
        ),
        ...(installation.instance ? { lifetime: installation.instance.lifetime.diagnostics } : {}),
      };
      const error = installation.error;
      installations.set(
        installation.id,
        Object.freeze(error === undefined ? base : { ...base, error }) as InstallationSnapshot,
      );
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
