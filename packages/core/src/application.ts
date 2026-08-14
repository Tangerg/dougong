import type {
  Application,
  CreateAppOptions,
  PluginChangeSet,
  PluginGroup,
  PluginHandle,
  PluginUpdate,
} from "./application-api";
import { ApplicationRuntime, type RuntimeChangeOutcome } from "./application-runtime";
import type { PluginChangeOperation } from "./change-set";
import type { Service } from "./contracts";
import {
  ApplicationDiagnostics,
  type ApplicationSnapshot,
  type ApplicationStatus,
} from "./diagnostics";
import { DougongError } from "./errors";
import { GroupCoordinator } from "./group-coordinator";
import type { GroupNode } from "./group";
import type { Logger } from "./lifetime";
import {
  type AnyPlugin,
  createInstallationSpec,
  type InstallationSpec,
  PluginInstallation,
} from "./plugin-installation";
import type { PluginDefinition, Provisions, Requirements } from "./plugin";
import { SerialQueue } from "./serial-queue";
import type { SnapshotView } from "./snapshot-view";

export type { InstallationStatus } from "./plugin-installation";
export type {
  ApplicationSnapshot,
  ApplicationStatus,
  GroupSnapshot,
  PluginSnapshot,
} from "./diagnostics";
export type {
  Application,
  CreateAppOptions,
  InstallationHandle,
  PluginChangeSet,
  PluginContainer,
  PluginGroup,
  PluginHandle,
  PluginUpdate,
} from "./application-api";

interface InstallationSnapshot {
  readonly id: string;
  readonly installation: PluginInstallation;
  readonly spec: InstallationSpec;
}

const defaultLogger: Logger = console;

type UnknownPluginUpdate = PluginUpdate<unknown, Requirements, Provisions, unknown>;

interface PluginHandleControl {
  attach(update: (change: UnknownPluginUpdate) => Promise<void>, remove: () => Promise<void>): void;
  revoke(): void;
}

type PluginHandleState<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> =
  | { readonly phase: "draft" }
  | {
      readonly phase: "attached";
      readonly update: (
        change: PluginUpdate<Config, Requires, Provides, ConfigInput>,
      ) => Promise<void>;
      readonly remove: () => Promise<void>;
    }
  | { readonly phase: "revoked" };

const pluginHandleControls = new WeakMap<object, PluginHandleControl>();

class PluginHandleImpl<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> implements PluginHandle<Config, Requires, Provides, ConfigInput> {
  readonly #installation: PluginInstallation;
  #state: PluginHandleState<Config, Requires, Provides, ConfigInput> = { phase: "draft" };

  constructor(installation: PluginInstallation) {
    this.#installation = installation;
    pluginHandleControls.set(this, {
      attach: (updateRecord, removeRecord) => {
        if (this.#state.phase !== "draft") {
          throw new TypeError(`Plugin '${this.#installation.id}' control is already sealed`);
        }
        this.#state = {
          phase: "attached",
          update: updateRecord as (
            update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
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

  async update(update: PluginUpdate<Config, Requires, Provides, ConfigInput>) {
    const state = this.#state;
    if (state.phase === "draft") throw this.#notCommitted();
    if (state.phase === "revoked") {
      throw (
        this.#installation.error ??
        new DougongError("PLUGIN_REMOVED", `Plugin '${this.#installation.id}' has been removed`)
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
      "PLUGIN_UNAVAILABLE",
      `Plugin '${this.#installation.id}' installation has not been committed`,
    );
  }
}

class ApplicationImpl implements Application {
  readonly name: string;
  readonly diagnostics: SnapshotView<ApplicationSnapshot>;

  readonly #installations = new Map<string, PluginInstallation>();
  readonly #ownedPluginHandles = new WeakMap<object, PluginInstallation>();
  readonly #pluginControlHandles = new WeakMap<
    PluginInstallation,
    PluginHandleImpl<unknown, Requirements, Provisions, unknown>
  >();
  readonly #diagnosticModel: ApplicationDiagnostics;
  readonly #logger: Logger;
  readonly #groups: GroupCoordinator;
  readonly #onError: (error: unknown) => void;
  readonly #runtime: ApplicationRuntime;

  #installationSequence = 0;
  #status: ApplicationStatus = "idle";
  readonly #commands = new SerialQueue();

  constructor(options: CreateAppOptions = {}) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Application options must be an object");
    }
    const name = options.name ?? "app";
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Application name must be a non-empty string");
    }
    if (name !== name.trim()) {
      throw new TypeError("Application name cannot start or end with whitespace");
    }
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TypeError("Application onError must be a function");
    }
    if (options.logger !== undefined && !isLogger(options.logger)) {
      throw new TypeError("Application logger must implement debug/info/warn/error");
    }

    this.name = name;
    this.#logger = options.logger ?? defaultLogger;
    this.#onError = options.onError ?? ((error) => this.#logger.error(error));
    this.#runtime = new ApplicationRuntime({
      applicationName: name,
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
    this.#diagnosticModel = new ApplicationDiagnostics(name, this.#groups.nodes(), (error) =>
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
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    return this.#groups.install(this.#groups.root, plugin, ...config);
  }

  change(): PluginChangeSet {
    return this.#groups.change(this.#groups.root);
  }

  group(name: string, configure: (group: PluginGroup) => void) {
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
      if (errors.length > 1) throw new AggregateError(errors, "Application shutdown failed");
    });
  }

  #createDraft(group: GroupNode, plugin: AnyPlugin, config: unknown) {
    group.assertAttached();
    const index = ++this.#installationSequence;
    const id = `${plugin.name}:${index}`;
    const installation = new PluginInstallation(
      id,
      index,
      group,
      createInstallationSpec(plugin, config),
    );
    const handle = new PluginHandleImpl<unknown, Requirements, Provisions, unknown>(installation);
    this.#ownedPluginHandles.set(handle, installation);
    this.#pluginControlHandles.set(installation, handle);
    return { installation, handle };
  }

  #resolveHandle(handle: object) {
    const installation = this.#ownedPluginHandles.get(handle);
    if (!installation) throw new TypeError("PluginHandle belongs to a different Application");
    return installation;
  }

  #executeChanges(operations: ReadonlyArray<PluginChangeOperation>) {
    const installed = operations
      .filter((operation): operation is Extract<PluginChangeOperation, { kind: "install" }> => {
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

  async #removeInstallations(operations: ReadonlyArray<PluginChangeOperation>) {
    if (operations.length && this.#status === "active") {
      await this.#transact(operations);
    } else {
      this.#applyChanges(operations);
      this.#settleChanges(operations);
    }
  }

  async #transact(operations: ReadonlyArray<PluginChangeOperation>) {
    const outcome = await this.#runTransaction(operations);
    this.#settleInstallations(outcome.affected);
    if (outcome.kind === "rolled-back") throw outcome.error;
    this.#settleChanges(operations);
  }

  async #runTransaction(
    operations: ReadonlyArray<PluginChangeOperation>,
  ): Promise<RuntimeChangeOutcome> {
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

  #applyChanges(operations: ReadonlyArray<PluginChangeOperation>) {
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
          "PLUGIN_REMOVED",
          `Plugin '${operation.installation.id}' has been removed`,
        );
      }
      if (
        operation.kind === "update" &&
        operation.declaration.kind !== "config" &&
        operation.declaration.plugin.name !== operation.installation.spec.plugin.name
      ) {
        throw new DougongError(
          "PLUGIN_IDENTITY",
          `Plugin '${operation.installation.id}' cannot change name from ` +
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

  #settleChanges(operations: ReadonlyArray<PluginChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "remove") {
        operation.installation.remove();
        operation.installation.settleReady();
        this.#revokeControl(operation.installation);
      } else if (this.#status !== "active") operation.installation.deactivate();
    }
  }

  #discardInstallation(installation: PluginInstallation, error: unknown) {
    installation.discard(error);
    this.#revokeControl(installation);
  }

  #attachInstallation(installation: PluginInstallation) {
    const handle = this.#pluginControlHandles.get(installation);
    if (!handle) throw new TypeError(`Plugin '${installation.id}' has no control handle`);
    const control = pluginHandleControls.get(handle);
    if (!control) throw new TypeError(`Plugin '${installation.id}' has no draft control`);
    installation.attach(() => this.#publishDiagnostics());
    control.attach(
      (update) => this.#groups.change(installation.group).update(handle, update).commit(),
      () => this.#groups.change(installation.group).remove(handle).commit(),
    );
  }

  #revokeControl(installation: PluginInstallation) {
    const handle = this.#pluginControlHandles.get(installation);
    if (handle) {
      pluginHandleControls.get(handle)?.revoke();
      pluginHandleControls.delete(handle);
    }
    this.#pluginControlHandles.delete(installation);
  }

  #settleInstallations(installations: Iterable<PluginInstallation>) {
    for (const installation of installations) installation.settleReady();
  }

  #captureInstallations(): InstallationSnapshot[] {
    return [...this.#installations].map(([id, installation]) => ({
      id,
      installation,
      spec: installation.spec,
    }));
  }

  #restoreInstallations(snapshot: ReadonlyArray<InstallationSnapshot>) {
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
          new AggregateError([error, reporterError], "Application error reporter failed"),
        );
      } catch {
        // Error observation must never mutate the runtime command being observed.
      }
    }
  }

  #setStatus(status: ApplicationStatus) {
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

export function createApp(options?: CreateAppOptions): Application {
  return new ApplicationImpl(options);
}
