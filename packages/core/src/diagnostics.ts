import type { GroupNode } from "./group";
import type { LifetimeSnapshot } from "./lifetime";
import type { PluginInstance, PluginStatus } from "./plugin-instance";
import { ReadonlyMapSnapshot } from "./readonly-map";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export type ApplicationStatus = "idle" | "starting" | "active" | "changing" | "stopping";

export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly status: PluginStatus;
  readonly requires: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly lifetime?: SnapshotView<LifetimeSnapshot>;
  readonly error?: unknown;
}

export interface GroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
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
    instances: Iterable<PluginInstance>,
    groups: Iterable<GroupNode>,
  ) {
    this.#revision++;
    this.#nextSnapshot = this.#snapshot(status, instances, groups);
    this.#source.invalidate();
  }

  #snapshot(
    status: ApplicationStatus,
    instances: Iterable<PluginInstance>,
    groupNodes: Iterable<GroupNode>,
  ) {
    const plugins = new Map<string, PluginSnapshot>();
    for (const instance of instances) {
      const base = {
        id: instance.id,
        name: instance.spec.plugin.name,
        group: instance.group.id,
        status: instance.status,
        requires: Object.freeze(
          Object.values(instance.spec.plugin.requires ?? {}).map((requirement) => {
            return requirement.kind === "optional" ? requirement.service.id : requirement.id;
          }),
        ),
        provides: Object.freeze(
          Object.values(instance.spec.plugin.provides ?? {}).map((token) => token.id),
        ),
        ...(instance.runtime ? { lifetime: instance.runtime.lifetime.diagnostics } : {}),
      };
      plugins.set(
        instance.id,
        Object.freeze(
          instance.error === undefined ? base : { ...base, error: instance.error },
        ) as PluginSnapshot,
      );
    }

    const groups = new Map<string, GroupSnapshot>();
    for (const group of groupNodes) {
      const base = { id: group.id, name: group.name };
      groups.set(
        group.id,
        Object.freeze(group.parent ? { ...base, parent: group.parent.id } : base),
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
