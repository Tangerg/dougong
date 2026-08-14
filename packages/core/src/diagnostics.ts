import type { GroupNode } from "./group";
import type { LifetimeSnapshot } from "./lifetime";
import type { PluginInstallation, InstallationStatus } from "./plugin-installation";
import { ReadonlyMapSnapshot } from "./readonly-map";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export type ApplicationStatus = "idle" | "starting" | "active" | "changing" | "stopping";

export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly groupId: string;
  readonly status: InstallationStatus;
  readonly requires: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly lifetime?: SnapshotView<LifetimeSnapshot>;
  readonly error?: unknown;
}

export interface GroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
}

export interface ApplicationSnapshot {
  readonly name: string;
  readonly status: ApplicationStatus;
  readonly revision: number;
  readonly plugins: ReadonlyMap<string, PluginSnapshot>;
  readonly groups: ReadonlyMap<string, GroupSnapshot>;
}

/** Immutable operational read model; never a service locator or control plane. */
export class ApplicationDiagnostics {
  readonly #name: string;
  readonly #source: SnapshotPublisher<ApplicationSnapshot>;
  #nextSnapshot: ApplicationSnapshot;
  #revision = 0;

  readonly view: SnapshotView<ApplicationSnapshot>;

  constructor(name: string, groups: Iterable<GroupNode>, report: (error: unknown) => void) {
    this.#name = name;
    this.#nextSnapshot = this.#snapshot("idle", [], groups);
    this.#source = new SnapshotPublisher(() => this.#nextSnapshot, report);
    this.view = this.#source.view;
  }

  publish(
    status: ApplicationStatus,
    installations: Iterable<PluginInstallation>,
    groups: Iterable<GroupNode>,
  ) {
    this.#revision++;
    this.#nextSnapshot = this.#snapshot(status, installations, groups);
    this.#source.invalidate();
  }

  #snapshot(
    status: ApplicationStatus,
    installations: Iterable<PluginInstallation>,
    groupNodes: Iterable<GroupNode>,
  ) {
    const plugins = new Map<string, PluginSnapshot>();
    for (const installation of installations) {
      const base = {
        id: installation.id,
        name: installation.spec.plugin.name,
        groupId: installation.groupId,
        status: installation.status,
        requires: Object.freeze(
          Object.values(installation.spec.plugin.requires ?? {}).map((requirement) => {
            return requirement.kind === "optional" ? requirement.service.id : requirement.id;
          }),
        ),
        provides: Object.freeze(
          Object.values(installation.spec.plugin.provides ?? {}).map((token) => token.id),
        ),
        ...(installation.runtime ? { lifetime: installation.runtime.lifetime.diagnostics } : {}),
      };
      const error = installation.error;
      plugins.set(
        installation.id,
        Object.freeze(error === undefined ? base : { ...base, error }) as PluginSnapshot,
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
      plugins: new ReadonlyMapSnapshot(plugins),
      groups: new ReadonlyMapSnapshot(groups),
    });
  }
}
