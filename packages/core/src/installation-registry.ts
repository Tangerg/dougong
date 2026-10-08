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
import { batchSnapshotNotifications } from "./snapshot-view";

type AnyInstallation = Installation<AnyPlugin>;
type AnyInstallationUpdate = InstallationUpdate<AnyPlugin>;

interface InstallationRegistryPort {
  readonly notifyChanged: () => void;
  readonly report: (error: unknown) => void;
  readonly settled: () => Promise<void>;
  readonly update: (
    installation: InstallationRecord,
    facade: AnyInstallation,
    update: AnyInstallationUpdate,
  ) => Promise<void>;
  readonly remove: (installation: InstallationRecord, facade: AnyInstallation) => Promise<void>;
}

class InstallationFacade<Declaration extends AnyPlugin> {
  readonly #installation: InstallationRecord;

  constructor(installation: InstallationRecord) {
    this.#installation = installation;
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

  get diagnostics() {
    return this.#installation.diagnostics;
  }

  ready() {
    return this.#installation.ready();
  }

  update(update: InstallationUpdate<Declaration>) {
    return this.#installation.requestUpdate(update as AnyInstallationUpdate);
  }

  remove() {
    return this.#installation.requestRemoval();
  }
}

/** Owns committed membership and grants the authority stored by each record. */
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

  contains(installation: InstallationRecord) {
    return this.#records.get(installation.id) === installation;
  }

  pendingOperations(operations: ReadonlyArray<ChangeOperation>) {
    return operations.filter(
      (operation) => operation.kind !== "remove" || this.contains(operation.installation),
    );
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
    // The public declaration marker is type-only; this identity map proves
    // provenance without granting the draft mutation authority.
    const facade = new InstallationFacade<AnyPlugin>(installation) as unknown as AnyInstallation;
    this.#owned.set(facade, installation);
    this.#facades.set(installation, facade);
    return { record: installation, facade };
  }

  resolve(value: object) {
    const installation = this.#owned.get(value);
    if (!installation) throw new TypeError("Installation belongs to a different Host");
    return installation;
  }

  attach(installation: InstallationRecord) {
    const facade = this.#facades.get(installation);
    if (!facade) throw new Error(`Installation '${installation.id}' has no public facade`);
    installation.attach({
      notifyChanged: this.#port.notifyChanged,
      report: this.#port.report,
      settled: this.#port.settled,
      update: (update) => this.#port.update(installation, facade, update),
      remove: () => this.#port.remove(installation, facade),
    });
  }

  /** Builds a candidate without changing committed declarations or membership. */
  draft(operations: ReadonlyArray<ChangeOperation>) {
    const declarations = this.declarations();
    for (const operation of operations) {
      const installation = operation.installation;
      if (operation.kind === "install") {
        installation.group.assertAttached();
        if (this.#records.has(installation.id)) {
          throw new Error(`Installation '${installation.id}' is already installed`);
        }
        declarations.set(installation, installation.declaration);
        continue;
      }
      if (!this.contains(installation)) throw installation.unavailableError();
      if (operation.kind === "remove") {
        declarations.delete(installation);
        continue;
      }
      const current = installation.declaration;
      const plugin =
        operation.declaration.kind === "config" ? current.plugin : operation.declaration.plugin;
      if (plugin.name !== current.plugin.name) {
        throw new DougongError(
          "INSTALLATION_IDENTITY",
          `Installation '${installation.id}' cannot change name from '${current.plugin.name}' to '${plugin.name}'`,
        );
      }
      const config =
        operation.declaration.kind === "plugin" ? current.config : operation.declaration.config;
      declarations.set(installation, createInstallationDeclaration(plugin, config));
    }
    return declarations;
  }

  commit(
    declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
    operations: ReadonlyArray<ChangeOperation>,
    active: boolean,
  ) {
    batchSnapshotNotifications(() => {
      this.#records.clear();
      for (const [installation, declaration] of declarations) {
        if (installation.declaration !== declaration) installation.replaceDeclaration(declaration);
        this.#records.set(installation.id, installation);
      }
      for (const operation of operations) {
        if (operation.kind === "remove") {
          operation.installation.remove();
          this.#facades.delete(operation.installation);
        } else if (!active) {
          operation.installation.deactivate();
        }
      }
      this.#port.notifyChanged();
    });
  }

  settleReadiness(records: Iterable<InstallationRecord>) {
    for (const installation of records) installation.settleReady();
  }

  discard(installation: InstallationRecord, error: unknown) {
    installation.discard(error);
    this.#facades.delete(installation);
  }

  declarations() {
    return new Map([...this.#records.values()].map((record) => [record, record.declaration]));
  }
}
