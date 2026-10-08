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
  readonly update: (
    installation: InstallationRecord,
    facade: AnyInstallation,
    update: AnyInstallationUpdate,
  ) => Promise<void>;
  readonly remove: (installation: InstallationRecord, facade: AnyInstallation) => Promise<void>;
}

interface InstallationControl {
  readonly attach: (
    update: (change: AnyInstallationUpdate) => Promise<void>,
    remove: () => Promise<void>,
  ) => void;
  readonly revoke: () => void;
}

type InstallationFacadeState<Declaration extends AnyPlugin> =
  | { readonly phase: "draft" }
  | {
      readonly phase: "attached";
      readonly update: (change: InstallationUpdate<Declaration>) => Promise<void>;
      readonly remove: () => Promise<void>;
    }
  | { readonly phase: "revoked" };

// The facade a caller receives is created before its ChangeSet commits, so it
// starts with no authority at all. `attach` grants it, `revoke` takes it back
// when the Installation leaves the graph. Keeping both off the object means
// public code holding the handle cannot call either.
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

  get diagnostics() {
    return this.#installation.diagnostics;
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
    // Removing something already removed succeeds. `update()` rejects in the
    // same state because it asks for a change that cannot happen, while
    // `remove()` only asks for an end state that already holds.
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
    const control = installationControls.get(facade);
    if (!control) throw new Error(`Installation '${installation.id}' has no draft control`);
    installation.attach(this.#port.notifyChanged, this.#port.report);
    control.attach(
      (update) => this.#port.update(installation, facade, update),
      () => this.#port.remove(installation, facade),
    );
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
          this.#revoke(operation.installation);
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
    this.#revoke(installation);
  }

  declarations() {
    return new Map([...this.#records.values()].map((record) => [record, record.declaration]));
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
