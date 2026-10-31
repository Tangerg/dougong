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
import type { InstallationDeclaration, InstallationRecord } from "./installation.js";
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

export function captureOrigin(value: unknown): InstallationOrigin | undefined {
  const captured = captureConfig(value);
  if (captured === undefined) return undefined;
  if (captured === null || Array.isArray(captured) || typeof captured !== "object") {
    throw new TypeError("Installation origin must be a data record");
  }
  return captured as InstallationOrigin;
}

export class ChangeSetDraft {
  readonly handle: ChangeSet = Object.freeze({
    install: this.install.bind(this),
    update: this.update.bind(this),
    remove: this.remove.bind(this),
    group: this.group.bind(this),
    removeGroup: this.removeGroup.bind(this),
  });
  #port: ChangePort | undefined;
  readonly #operations: ChangeOperation[] = [];
  readonly #targets = new Set<object>();

  constructor(port: ChangePort) {
    this.#port = port;
    Object.freeze(this);
  }

  install<P extends AnyPlugin>(plugin: P, options: InstallationOptions<P>): Installation<P> {
    const port = this.#requireOpen();
    const input = normalizePlainRecord(options, "Installation options", {
      fields: new Set(["id", "config", "origin", "group"]),
    });
    assertId(input.id, "Installation id");
    const group = input.group === undefined ? undefined : port.resolveGroup(input.group as object);
    const declaration = Object.freeze({
      plugin: normalizePlugin(plugin),
      config: captureConfig(input.config),
      origin: captureOrigin(input.origin),
    });
    this.#requireOpen();
    const installation = port.create(input.id, group);
    this.#stage(installation, { kind: "install", installation, declaration });
    return installation.facade as unknown as Installation<P>;
  }

  update<P extends AnyPlugin>(installation: Installation<P>, update: InstallationUpdate<P>) {
    const port = this.#requireOpen();
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
    const record = this.#requireOpen().resolve(installation);
    this.#stage(record, { kind: "remove", installation: record });
  }

  group(id: string, parent?: Group) {
    const port = this.#requireOpen();
    assertId(id, "Group id");
    const group = port.createGroup(
      id,
      parent === undefined ? undefined : port.resolveGroup(parent),
    );
    this.#stage(group, { kind: "group", group });
    return group.facade;
  }

  removeGroup(group: Group) {
    const record = this.#requireOpen().resolveGroup(group);
    this.#stage(record, { kind: "remove-group", group: record });
  }

  take(): ReadonlyArray<ChangeOperation> {
    this.#requireOpen();
    this.#port = undefined;
    const result = Object.freeze(this.#operations.splice(0));
    this.#targets.clear();
    return result;
  }

  #stage(target: object, operation: ChangeOperation) {
    this.#requireOpen();
    if (this.#targets.has(target))
      throw new TypeError("A target can appear only once in a ChangeSet");
    this.#targets.add(target);
    this.#operations.push(Object.freeze(operation));
  }

  #requireOpen() {
    if (!this.#port) throw new TypeError("ChangeSet has already been planned");
    return this.#port;
  }
}
