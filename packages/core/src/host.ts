import type {
  Host,
  HostOptions,
  ChangeSet,
  Group,
  Installation,
  InstallationUpdate,
} from "./host-api";
import { Runtime, type RuntimeChangeOutcome } from "./runtime";
import type { ChangeOperation } from "./change-set";
import type { Service } from "./contracts";
import { HostDiagnostics, type HostSnapshot, type HostStatus } from "./diagnostics";
import { DougongError } from "./errors";
import { GroupCoordinator } from "./group-coordinator";
import type { GroupNode } from "./group";
import type { Logger } from "./lifetime";
import {
  type AnyPlugin,
  createInstallationSpec,
  type InstallationSpec,
  InstallationRecord,
} from "./installation";
import type { Plugin, Provisions, Requirements } from "./plugin";
import { SerialQueue } from "./serial-queue";
import type { SnapshotView } from "./snapshot-view";

export type { InstallationStatus } from "./installation";
export type { HostSnapshot, HostStatus, GroupSnapshot, InstallationSnapshot } from "./diagnostics";
export type {
  Host,
  HostOptions,
  ChangeSet,
  Installer,
  Group,
  Installation,
  InstallationUpdate,
} from "./host-api";

interface InstallationCapture {
  readonly id: string;
  readonly installation: InstallationRecord;
  readonly spec: InstallationSpec;
}

const defaultLogger: Logger = console;

type UnknownInstallationUpdate = InstallationUpdate<unknown, Requirements, Provisions, unknown>;

interface InstallationControl {
  attach(
    update: (change: UnknownInstallationUpdate) => Promise<void>,
    remove: () => Promise<void>,
  ): void;
  revoke(): void;
}

type InstallationImplState<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> =
  | { readonly phase: "draft" }
  | {
      readonly phase: "attached";
      readonly update: (
        change: InstallationUpdate<Config, Requires, Provides, ConfigInput>,
      ) => Promise<void>;
      readonly remove: () => Promise<void>;
    }
  | { readonly phase: "revoked" };

const installationControls = new WeakMap<object, InstallationControl>();

class InstallationImpl<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> implements Installation<Config, Requires, Provides, ConfigInput> {
  readonly #installation: InstallationRecord;
  #state: InstallationImplState<Config, Requires, Provides, ConfigInput> = { phase: "draft" };

  constructor(installation: InstallationRecord) {
    this.#installation = installation;
    installationControls.set(this, {
      attach: (updateRecord, removeRecord) => {
        if (this.#state.phase !== "draft") {
          throw new TypeError(`Plugin '${this.#installation.id}' control is already sealed`);
        }
        this.#state = {
          phase: "attached",
          update: updateRecord as (
            update: InstallationUpdate<Config, Requires, Provides, ConfigInput>,
          ) => Promise<void>,
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

  async update(update: InstallationUpdate<Config, Requires, Provides, ConfigInput>) {
    const state = this.#state;
    if (state.phase === "draft") throw this.#notCommitted();
    if (state.phase === "revoked") {
      throw (
        this.#installation.error ??
        new DougongError(
          "INSTALLATION_REMOVED",
          `Installation '${this.#installation.id}' has been removed`,
        )
      );
    }
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

class HostImpl implements Host {
  readonly name: string;
  readonly diagnostics: SnapshotView<HostSnapshot>;

  readonly #installations = new Map<string, InstallationRecord>();
  readonly #ownedInstallations = new WeakMap<object, InstallationRecord>();
  readonly #installationImpls = new WeakMap<
    InstallationRecord,
    InstallationImpl<unknown, Requirements, Provisions, unknown>
  >();
  readonly #diagnosticModel: HostDiagnostics;
  readonly #logger: Logger;
  readonly #groups: GroupCoordinator;
  readonly #onError: (error: unknown) => void;
  readonly #runtime: Runtime;

  #installationSequence = 0;
  #status: HostStatus = "idle";
  readonly #commands = new SerialQueue();

  constructor(options: HostOptions = {}) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Host options must be an object");
    }
    const name = options.name ?? "app";
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Host name must be a non-empty string");
    }
    if (name !== name.trim()) {
      throw new TypeError("Host name cannot start or end with whitespace");
    }
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TypeError("Host onError must be a function");
    }
    if (options.logger !== undefined && !isLogger(options.logger)) {
      throw new TypeError("Host logger must implement debug/info/warn/error");
    }

    this.name = name;
    this.#logger = options.logger ?? defaultLogger;
    this.#onError = options.onError ?? ((error) => this.#logger.error(error));
    this.#runtime = new Runtime({
      hostName: name,
      logger: this.#logger,
      isInstalled: (installationId) => this.#installations.has(installationId),
      report: (error) => this.#report(error),
    });
    this.#groups = new GroupCoordinator(name, {
      installations: () => this.#installations.values(),
      createDraft: (group, plugin, config) => this.#createDraft(group, plugin, config),
      resolveHandle: (handle) => this.#resolveHandle(handle),
      executeChanges: (operations) => this.#executeChanges(operations),
      attachInstallation: (installation) => this.#attachInstallation(installation),
      discardInstallation: (installation, error) => {
        this.#discardInstallation(installation, error);
      },
      runExclusive: (operation) => this.#commands.run(operation),
      removeInstallations: (operations) => this.#removeInstallations(operations),
      notifyChanged: () => this.#publishDiagnostics(),
    });
    this.#diagnosticModel = new HostDiagnostics(name, this.#groups.nodes(), (error) =>
      this.#report(error),
    );
    this.diagnostics = this.#diagnosticModel.view;
    Object.freeze(this);
  }

  get status() {
    return this.#status;
  }

  get<T>(token: Service<T>): T {
    const availability = this.#status === "active" ? "available" : "unavailable";
    return this.#runtime.get(token, availability);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    return this.#groups.install(this.#groups.root, plugin, ...config);
  }

  change(): ChangeSet {
    return this.#groups.change(this.#groups.root);
  }

  group(name: string, configure: (group: Group) => void) {
    return this.#groups.create(this.#groups.root, name, configure);
  }

  start() {
    return this.#commands.run(async () => {
      if (this.#status === "active") return;
      this.#setStatus("starting");
      try {
        const plan = this.#runtime.buildPlan(this.#installations.values());
        await this.#runtime.start(plan);
        this.#setStatus("active");
        this.#settleInstallations(plan.order);
      } catch (error) {
        this.#setStatus("idle");
        for (const installation of this.#installations.values()) {
          if (installation.status !== "active") installation.fail(error);
        }
        this.#settleInstallations(this.#installations.values());
        throw error;
      }
    });
  }

  stop() {
    return this.#commands.run(async () => {
      if (this.#status === "idle") return;
      this.#setStatus("stopping");
      const errors = await this.#runtime.stop();
      this.#setStatus("idle");
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Host shutdown failed");
    });
  }

  #createDraft(group: GroupNode, plugin: AnyPlugin, config: unknown) {
    group.assertAttached();
    const index = ++this.#installationSequence;
    const id = `${plugin.name}:${index}`;
    const installation = new InstallationRecord(
      id,
      index,
      group,
      createInstallationSpec(plugin, config),
    );
    const handle = new InstallationImpl<unknown, Requirements, Provisions, unknown>(installation);
    this.#ownedInstallations.set(handle, installation);
    this.#installationImpls.set(installation, handle);
    return { installation, handle };
  }

  #resolveHandle(handle: object) {
    const installation = this.#ownedInstallations.get(handle);
    if (!installation) throw new TypeError("Installation belongs to a different Host");
    return installation;
  }

  #executeChanges(operations: ReadonlyArray<ChangeOperation>) {
    const installed = operations
      .filter((operation): operation is Extract<ChangeOperation, { kind: "install" }> => {
        return operation.kind === "install";
      })
      .map((operation) => operation.installation);

    return this.#commands.run(async () => {
      try {
        if (this.#status === "active") {
          await this.#transact(operations);
        } else {
          this.#applyChanges(operations);
          this.#settleChanges(operations);
        }
        this.#publishDiagnostics();
      } catch (error) {
        for (const installation of installed) {
          if (this.#installations.get(installation.id) !== installation)
            this.#discardInstallation(installation, error);
        }
        throw error;
      }
    });
  }

  async #removeInstallations(operations: ReadonlyArray<ChangeOperation>) {
    if (operations.length && this.#status === "active") {
      await this.#transact(operations);
    } else {
      this.#applyChanges(operations);
      this.#settleChanges(operations);
    }
  }

  async #transact(operations: ReadonlyArray<ChangeOperation>) {
    const outcome = await this.#runTransaction(operations);
    this.#settleInstallations(outcome.affected);
    if (outcome.kind === "rolled-back") throw outcome.error;
    this.#settleChanges(operations);
  }

  async #runTransaction(operations: ReadonlyArray<ChangeOperation>): Promise<RuntimeChangeOutcome> {
    const snapshot = this.#captureInstallations();
    const changed = new Set(operations.map((operation) => operation.installation));
    this.#setStatus("changing");

    let nextPlan;
    try {
      this.#applyChanges(operations);
      nextPlan = this.#runtime.buildPlan(this.#installations.values());
    } catch (error) {
      this.#restoreInstallations(snapshot);
      this.#setStatus("active");
      throw error;
    }

    try {
      const outcome = await this.#runtime.transition(nextPlan, changed, () =>
        this.#restoreInstallations(snapshot),
      );
      this.#setStatus("active");
      return outcome;
    } catch (error) {
      this.#setStatus(this.#runtime.hasCommittedPlan ? "active" : "idle");
      throw error;
    }
  }

  #applyChanges(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "install") {
        operation.installation.group.assertAttached();
        if (this.#installations.has(operation.installation.id)) {
          throw new TypeError(`Plugin '${operation.installation.id}' is already installed`);
        }
        continue;
      }

      const installed =
        this.#installations.get(operation.installation.id) === operation.installation;
      if (
        operation.kind === "remove" &&
        !installed &&
        operation.installation.status === "removed"
      ) {
        continue;
      }
      if (!installed) {
        throw new DougongError(
          "INSTALLATION_REMOVED",
          `Installation '${operation.installation.id}' has been removed`,
        );
      }
      if (
        operation.kind === "update" &&
        operation.declaration.kind !== "config" &&
        operation.declaration.plugin.name !== operation.installation.spec.plugin.name
      ) {
        throw new DougongError(
          "INSTALLATION_IDENTITY",
          `Installation '${operation.installation.id}' cannot change name from ` +
            `'${operation.installation.spec.plugin.name}' to '${operation.declaration.plugin.name}'`,
        );
      }
    }

    for (const operation of operations) {
      if (operation.kind === "install") {
        this.#installations.set(operation.installation.id, operation.installation);
      } else if (operation.kind === "update") {
        const current = operation.installation.spec;
        const plugin =
          operation.declaration.kind === "config" ? current.plugin : operation.declaration.plugin;
        const config =
          operation.declaration.kind === "plugin" ? current.config : operation.declaration.config;
        operation.installation.reconfigure(createInstallationSpec(plugin, config));
      } else if (this.#installations.get(operation.installation.id) === operation.installation) {
        this.#installations.delete(operation.installation.id);
      }
    }
  }

  #settleChanges(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "remove") {
        operation.installation.remove();
        operation.installation.settleReady();
        this.#revokeControl(operation.installation);
      } else if (this.#status !== "active") operation.installation.deactivate();
    }
  }

  #discardInstallation(installation: InstallationRecord, error: unknown) {
    installation.discard(error);
    this.#revokeControl(installation);
  }

  #attachInstallation(installation: InstallationRecord) {
    const handle = this.#installationImpls.get(installation);
    if (!handle) throw new TypeError(`Plugin '${installation.id}' has no control handle`);
    const control = installationControls.get(handle);
    if (!control) throw new TypeError(`Plugin '${installation.id}' has no draft control`);
    installation.attach(() => this.#publishDiagnostics());
    control.attach(
      (update) => this.#groups.change(installation.group).update(handle, update).commit(),
      () => this.#groups.change(installation.group).remove(handle).commit(),
    );
  }

  #revokeControl(installation: InstallationRecord) {
    const handle = this.#installationImpls.get(installation);
    if (handle) {
      installationControls.get(handle)?.revoke();
      installationControls.delete(handle);
    }
    this.#installationImpls.delete(installation);
  }

  #settleInstallations(installations: Iterable<InstallationRecord>) {
    for (const installation of installations) installation.settleReady();
  }

  #captureInstallations(): InstallationCapture[] {
    return [...this.#installations].map(([id, installation]) => ({
      id,
      installation,
      spec: installation.spec,
    }));
  }

  #restoreInstallations(snapshot: ReadonlyArray<InstallationCapture>) {
    this.#installations.clear();
    for (const item of snapshot) {
      item.installation.reconfigure(item.spec);
      this.#installations.set(item.id, item.installation);
    }
  }

  #report(error: unknown) {
    try {
      this.#onError(error);
    } catch (reporterError) {
      try {
        this.#logger.error(
          new AggregateError([error, reporterError], "Host error reporter failed"),
        );
      } catch {
        // Error observation must never mutate the runtime command being observed.
      }
    }
  }

  #setStatus(status: HostStatus) {
    this.#status = status;
    this.#publishDiagnostics();
  }

  #publishDiagnostics() {
    this.#diagnosticModel.publish(this.#status, this.#installations.values(), this.#groups.nodes());
  }
}

function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Logger>;
  return [candidate.debug, candidate.info, candidate.warn, candidate.error].every(
    (method) => typeof method === "function",
  );
}

export function createHost(options?: HostOptions): Host {
  return new HostImpl(options);
}
