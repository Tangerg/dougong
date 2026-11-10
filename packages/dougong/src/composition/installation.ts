import { DougongError, installationConflictCode } from "../contracts/errors.js";
import type { Installation, InstallationOrigin, InstallationState } from "./declarations.js";
import { normalizePlugin, type AnyPlugin, type NormalizedPlugin } from "./plugin.js";
import { captureConfiguration, type ConfigurationValue } from "./configuration.js";
import type { GroupNode } from "./group.js";

export interface InstallationDeclaration {
  readonly plugin: NormalizedPlugin;
  readonly configuration: ConfigurationValue | undefined;
  readonly origin: InstallationOrigin | undefined;
}

export function claimInstallationId(ids: Set<string>, id: string) {
  if (ids.has(id))
    throw new DougongError(installationConflictCode, "Installation id is already installed: " + id);
  ids.add(id);
}

export function captureInstallationDeclaration(
  plugin: AnyPlugin,
  configuration: unknown,
  origin: unknown,
): InstallationDeclaration {
  return Object.freeze({
    plugin: normalizePlugin(plugin),
    configuration: captureConfiguration(configuration),
    origin: captureOrigin(origin),
  });
}

export function captureOrigin(value: unknown): InstallationOrigin | undefined {
  const captured = captureConfiguration(value);
  if (captured === undefined) return undefined;
  if (captured === null || Array.isArray(captured) || typeof captured !== "object") {
    throw new TypeError("Installation origin must be a data record");
  }
  return captured as InstallationOrigin;
}

export interface InstallationProjection {
  readonly status: InstallationState;
  readonly origin: InstallationOrigin | undefined;
}

// Pending identities share only an inert status cell, never the Host or a candidate declaration.
export class PendingInstallations {
  readonly #projection: { status: "pending" | "removed"; origin: undefined } = {
    status: "pending",
    origin: undefined,
  };
  attach(installation: InstallationRecord) {
    const projection = this.#projection;
    installation.attach(() => projection);
  }
  retire() {
    this.#projection.status = "removed";
  }
}

// The status projection is read through whichever owner currently holds this identity:
// a pending draft or Plan, then the Engine; a terminal projection remains after the last owner leaves.
export class InstallationRecord {
  readonly id: string;
  readonly group: GroupNode | undefined;
  readonly facade: Installation;
  #read: (() => InstallationProjection) | undefined;
  #terminal: InstallationProjection = Object.freeze({ status: "pending", origin: undefined });

  constructor(id: string, group: GroupNode | undefined) {
    this.id = id;
    this.group = group;
    const record = this;
    this.facade = Object.freeze({
      id,
      groupId: group?.id,
      get status() {
        return record.#projection().status;
      },
      get origin() {
        return record.#projection().origin;
      },
    }) as Installation;
  }

  get groupId() {
    return this.group?.id;
  }

  attach(read: () => InstallationProjection) {
    this.#read = read;
  }

  detach(projection: InstallationProjection) {
    this.#terminal = Object.freeze(projection);
    this.#read = undefined;
  }

  #projection() {
    return this.#read?.() ?? this.#terminal;
  }
}
