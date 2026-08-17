import type { ChangeOperation } from "./change-set";
import { DougongError } from "./errors";
import type { GroupNode } from "./group";
import type { Installation, InstallationUpdate } from "./host-api";
import {
  createInstallationDeclaration,
  type InstallationDeclaration,
  InstallationRecord,
} from "./installation";
import type { AnyPlugin, NormalizedPlugin } from "./plugin";

type AnyInstallation = Installation<AnyPlugin>;
type AnyInstallationUpdate = InstallationUpdate<AnyPlugin>;

interface InstallationRegistryPort {
  readonly notifyChanged: () => void;
  readonly update: (
    installation: InstallationRecord,
    facade: AnyInstallation,
    update: AnyInstallationUpdate,
  ) => Promise<void>;
  readonly remove: (installation: InstallationRecord, facade: AnyInstallation) => Promise<void>;
}

interface InstallationCapture {
  readonly id: string;
  readonly installation: InstallationRecord;
  readonly declaration: InstallationDeclaration;
}

interface InstallationControl {
  attach(
    update: (change: AnyInstallationUpdate) => Promise<void>,
    remove: () => Promise<void>,
  ): void;
  revoke(): void;
}

type InstallationFacadeState<Declaration extends AnyPlugin> =
  | { readonly phase: "draft" }
  | {
      readonly phase: "attached";
      readonly update: (change: InstallationUpdate<Declaration>) => Promise<void>;
      readonly remove: () => Promise<void>;
    }
  | { readonly phase: "revoked" };

const installationControls = new WeakMap<object, InstallationControl>();

class InstallationFacade<Declaration extends AnyPlugin> {
  readonly #installation: InstallationRecord;
  #state: InstallationFacadeState<Declaration> = { phase: "draft" };

  constructor(installation: InstallationRecord) {
    this.#installation = installation;
    installationControls.set(this, {
      attach: (updateRecord, removeRecord) => {
        if (this.#state.phase !== "draft") {
          throw new Error(`Installation '${this.#installation.id}' control is already sealed`);
        }
        this.#state = {
          phase: "attached",
          update: updateRecord as (update: InstallationUpdate<Declaration>) => Promise<void>,
          remove: removeRecord,
        };
      },
      revoke: () => {
        this.#state = { phase: "revoked" };
      },
    });
    Object.freeze(this);
  }

  get id() {
    return this.#installation.id;
  }

  get groupId() {
    return this.#installation.groupId;
  }

  get status() {
    return this.#installation.status;
  }

  ready() {
    return this.#installation.ready();
  }

  async update(update: InstallationUpdate<Declaration>) {
    const state = this.#state;
    if (state.phase === "draft") throw this.#notCommitted();
    if (state.phase === "revoked") throw this.#installation.unavailableError();
    await state.update(update);
  }

  async remove() {
    const state = this.#state;
    if (state.phase === "draft") throw this.#notCommitted();
    if (state.phase === "attached") await state.remove();
  }

  #notCommitted() {
    return new DougongError(
      "INSTALLATION_UNAVAILABLE",
      `Installation '${this.#installation.id}' has not been committed`,
    );
  }
}

/** Owns Installation declarations, public facade authority and stable lookup. */
export class InstallationRegistry {
  readonly #records = new Map<string, InstallationRecord>();
  readonly #owned = new WeakMap<object, InstallationRecord>();
  readonly #facades = new WeakMap<InstallationRecord, AnyInstallation>();
  readonly #port: InstallationRegistryPort;
  #sequence = 0;

  constructor(port: InstallationRegistryPort) {
    this.#port = port;
  }

  values() {
    return this.#records.values();
  }

  has(id: string) {
    return this.#records.has(id);
  }

  contains(installation: InstallationRecord) {
    return this.#records.get(installation.id) === installation;
  }

  create(group: GroupNode, plugin: NormalizedPlugin, config: unknown) {
    group.assertAttached();
    const index = ++this.#sequence;
    const installation = new InstallationRecord(
      `${plugin.name}:${index}`,
      index,
      group,
      createInstallationDeclaration(plugin, config),
    );
    // The public declaration marker is type-only; runtime authority is the
    // WeakMap identity registered immediately below.
    const facade = new InstallationFacade<AnyPlugin>(installation) as unknown as AnyInstallation;
    this.#owned.set(facade, installation);
    this.#facades.set(installation, facade);
    return { record: installation, publicInstallation: facade };
  }

  resolve(value: object) {
    const installation = this.#owned.get(value);
    if (!installation) throw new TypeError("Installation belongs to a different Host");
    return installation;
  }

  attach(installation: InstallationRecord) {
    const facade = this.#facades.get(installation);
    if (!facade) throw new Error(`Installation '${installation.id}' has no public facade`);
    const control = installationControls.get(facade);
    if (!control) throw new Error(`Installation '${installation.id}' has no draft control`);
    installation.attach(this.#port.notifyChanged);
    control.attach(
      (update) => this.#port.update(installation, facade, update),
      () => this.#port.remove(installation, facade),
    );
  }

  apply(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "install") {
        operation.installation.group.assertAttached();
        if (this.#records.has(operation.installation.id)) {
          throw new Error(`Installation '${operation.installation.id}' is already installed`);
        }
        continue;
      }

      if (!this.contains(operation.installation)) {
        throw operation.installation.unavailableError();
      }
      if (
        operation.kind === "update" &&
        operation.declaration.kind !== "config" &&
        operation.declaration.plugin.name !== operation.installation.declaration.plugin.name
      ) {
        throw new DougongError(
          "INSTALLATION_IDENTITY",
          `Installation '${operation.installation.id}' cannot change name from ` +
            `'${operation.installation.declaration.plugin.name}' to '${operation.declaration.plugin.name}'`,
        );
      }
    }

    for (const operation of operations) {
      if (operation.kind === "install") {
        this.#records.set(operation.installation.id, operation.installation);
      } else if (operation.kind === "update") {
        const current = operation.installation.declaration;
        const plugin =
          operation.declaration.kind === "config" ? current.plugin : operation.declaration.plugin;
        const config =
          operation.declaration.kind === "plugin" ? current.config : operation.declaration.config;
        operation.installation.replaceDeclaration(createInstallationDeclaration(plugin, config));
      } else if (this.contains(operation.installation)) {
        this.#records.delete(operation.installation.id);
      }
    }
  }

  settleChanges(operations: ReadonlyArray<ChangeOperation>, active: boolean) {
    for (const operation of operations) {
      if (operation.kind === "remove") {
        operation.installation.remove();
        operation.installation.settleReady();
        this.#revoke(operation.installation);
      } else if (!active) {
        operation.installation.deactivate();
      }
    }
  }

  settleReadiness(records: Iterable<InstallationRecord>) {
    for (const installation of records) installation.settleReady();
  }

  discard(installation: InstallationRecord, error: unknown) {
    installation.discard(error);
    this.#revoke(installation);
  }

  capture(): ReadonlyArray<InstallationCapture> {
    return [...this.#records].map(([id, installation]) => ({
      id,
      installation,
      declaration: installation.declaration,
    }));
  }

  restore(snapshot: ReadonlyArray<InstallationCapture>) {
    this.#records.clear();
    for (const item of snapshot) {
      item.installation.replaceDeclaration(item.declaration);
      this.#records.set(item.id, item.installation);
    }
  }

  #revoke(installation: InstallationRecord) {
    const facade = this.#facades.get(installation);
    if (facade) {
      installationControls.get(facade)?.revoke();
      installationControls.delete(facade);
    }
    this.#facades.delete(installation);
  }
}
