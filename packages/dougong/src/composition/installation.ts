import type { InstallationState } from "../contracts/status.js";
import type { Installation, InstallationOrigin } from "./declarations.js";
import type { NormalizedPlugin } from "./plugin.js";
import type { ConfigValue } from "./configuration.js";
import type { GroupNode } from "./group.js";

export interface InstallationDeclaration {
  readonly plugin: NormalizedPlugin;
  readonly config: ConfigValue | undefined;
  readonly origin: InstallationOrigin | undefined;
}

export interface InstallationProjection {
  readonly status: InstallationState;
  readonly origin: InstallationOrigin | undefined;
}

export class InstallationRecord {
  readonly facade: Installation;
  #read: (() => InstallationProjection) | undefined;
  #terminal: InstallationProjection = Object.freeze({ status: "pending", origin: undefined });

  constructor(
    readonly id: string,
    readonly index: number,
    readonly group: GroupNode | undefined,
  ) {
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
