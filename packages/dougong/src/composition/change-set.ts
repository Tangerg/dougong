import { DougongError, quarantinedHost } from "../contracts/errors.js";
import { captureConfig, type ConfigValue } from "./configuration.js";
import { normalizePlugin, type AnyPlugin, type NormalizedPlugin } from "./plugin.js";
import { normalizePlainRecord } from "../internal/record.js";
import type {
  ChangeSet,
  Group,
  Installation,
  InstallationOptions,
  InstallationOrigin,
  InstallationUpdate,
} from "./declarations.js";
import {
  PendingInstallations,
  captureInstallationDeclaration,
  captureOrigin,
  type InstallationDeclaration,
  type InstallationRecord,
} from "./installation.js";
import type { GroupNode } from "./group.js";

export type ChangeOperation =
  | {
      readonly kind: "install";
      readonly installation: InstallationRecord;
      readonly declaration: InstallationDeclaration;
    }
  | {
      readonly kind: "update";
      readonly installation: InstallationRecord;
      readonly update: Readonly<{
        plugin?: NormalizedPlugin;
        config?: ConfigValue | undefined;
        origin?: InstallationOrigin | undefined;
      }>;
    }
  | { readonly kind: "remove"; readonly installation: InstallationRecord }
  | { readonly kind: "group"; readonly group: GroupNode }
  | { readonly kind: "remove-group"; readonly group: GroupNode };

export interface ChangePort {
  readonly create: (id: string, group: GroupNode | undefined) => InstallationRecord;
  readonly resolve: (installation: object) => InstallationRecord;
  readonly createGroup: (id: string, parent: GroupNode | undefined) => GroupNode;
  readonly resolveGroup: (group: object) => GroupNode;
}

export function assertId(id: unknown, label: string): asserts id is string {
  if (typeof id !== "string" || !id.trim() || id.trim() !== id) {
    throw new TypeError(label + " must be a non-empty trimmed string");
  }
}

interface DraftState {
  readonly port: ChangePort;
  readonly operations: ChangeOperation[];
  readonly targets: Set<object>;
}

export class ChangeSets {
  #open: WeakMap<ChangeSet, DraftState> | number = new WeakMap();
  readonly #pending = new PendingInstallations();

  create(port: ChangePort): ChangeSet {
    const draft = new ChangeSetDraft(this);
    this.#registry().set(draft.handle, { port, operations: [], targets: new Set() });
    return draft.handle;
  }

  take(change: ChangeSet): ReadonlyArray<ChangeOperation> {
    const registry = this.#registry();
    const state = registry.get(change);
    if (!state)
      throw new DougongError(
        "CHANGE_FOREIGN",
        "ChangeSet belongs to another Host or was already planned",
      );
    registry.delete(change);
    return Object.freeze(state.operations);
  }

  requireOpen(change: ChangeSet) {
    const state = this.#registry().get(change);
    if (!state) throw new TypeError("ChangeSet has already been planned");
    return state;
  }

  track(installation: InstallationRecord) {
    this.#pending.attach(installation);
  }

  close(revision: number) {
    this.#open = revision;
    this.#pending.retire();
  }

  #registry() {
    if (typeof this.#open === "number") throw quarantinedHost(this.#open);
    return this.#open;
  }
}

class ChangeSetDraft {
  readonly handle: ChangeSet = Object.freeze({
    install: this.install.bind(this),
    update: this.update.bind(this),
    remove: this.remove.bind(this),
    group: this.group.bind(this),
    removeGroup: this.removeGroup.bind(this),
  });
  constructor(private readonly authority: ChangeSets) {
    Object.freeze(this);
  }

  install<P extends AnyPlugin>(plugin: P, options: InstallationOptions<P>): Installation<P> {
    const { port } = this.#requireOpen();
    const input = normalizePlainRecord(options, "Installation options", {
      fields: new Set(["id", "config", "origin", "group"]),
    });
    assertId(input.id, "Installation id");
    const group = input.group === undefined ? undefined : port.resolveGroup(input.group as object);
    const declaration = captureInstallationDeclaration(plugin, input.config, input.origin);
    this.#requireOpen();
    const installation = port.create(input.id, group);
    this.#stage(installation, { kind: "install", installation, declaration });
    return installation.facade as unknown as Installation<P>;
  }

  update<P extends AnyPlugin>(installation: Installation<P>, update: InstallationUpdate<P>) {
    const { port } = this.#requireOpen();
    const input = normalizePlainRecord(update, "Installation update", {
      fields: new Set(["plugin", "config", "origin"]),
    });
    const hasPlugin = Object.hasOwn(input, "plugin");
    const hasConfig = Object.hasOwn(input, "config");
    if (!hasPlugin && !hasConfig)
      throw new TypeError("Installation update requires plugin or config");
    if (!hasPlugin && Object.hasOwn(input, "origin"))
      throw new TypeError("Origin can only change with its Plugin");
    const replacement = {
      ...(hasPlugin
        ? {
            plugin: normalizePlugin(input.plugin as AnyPlugin),
            origin: captureOrigin(input.origin),
          }
        : {}),
      ...(hasConfig ? { config: captureConfig(input.config) } : {}),
    };
    const record = port.resolve(installation);
    this.#stage(record, {
      kind: "update",
      installation: record,
      update: Object.freeze(replacement),
    });
  }

  remove<P extends AnyPlugin>(installation: Installation<P>) {
    const record = this.#requireOpen().port.resolve(installation);
    this.#stage(record, { kind: "remove", installation: record });
  }

  group(id: string, parent?: Group) {
    const { port } = this.#requireOpen();
    assertId(id, "Group id");
    const group = port.createGroup(
      id,
      parent === undefined ? undefined : port.resolveGroup(parent),
    );
    this.#stage(group, { kind: "group", group });
    return group.facade;
  }

  removeGroup(group: Group) {
    const record = this.#requireOpen().port.resolveGroup(group);
    this.#stage(record, { kind: "remove-group", group: record });
  }

  #stage(target: object, operation: ChangeOperation) {
    const { targets, operations } = this.#requireOpen();
    if (targets.has(target)) throw new TypeError("A target can appear only once in a ChangeSet");
    if (operation.kind === "install") this.authority.track(operation.installation);
    targets.add(target);
    operations.push(Object.freeze(operation));
  }

  #requireOpen() {
    return this.authority.requireOpen(this.handle);
  }
}
