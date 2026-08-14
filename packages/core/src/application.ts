import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  Application,
  CreateAppOptions,
  PluginChangeSet,
  PluginGroup,
  PluginHandle,
  PluginUpdate,
} from "./application-api";
import { cancelPluginChangeSet, PluginChangeSetDraft, type ChangeOperation } from "./change-set";
import type { ContractKind, Event, Extension, Service } from "./contracts";
import {
  ApplicationDiagnostics,
  type ApplicationSnapshot,
  type ApplicationStatus,
} from "./diagnostics";
import { ConfigValidationError, DougongError, type ValidationIssue } from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import { ExtensionRegistry, type ExtensionView } from "./extension-store";
import { GroupNode } from "./group";
import { Lifetime, type LifetimeHost, type Logger, type PluginMeta } from "./lifetime";
import { PluginGraph } from "./plugin-graph";
import {
  type AnyPlugin,
  installation,
  type InstallationSpec,
  PluginInstance as PluginRecord,
  type PluginRuntime,
  type PluginStatus,
} from "./plugin-instance";
import type { PluginContext, PluginDefinition, Provisions, Requirements } from "./plugin";
import type { Publication } from "./resource";
import type { SnapshotView } from "./snapshot-view";

export type { PluginStatus } from "./plugin-instance";
export type {
  ApplicationSnapshot,
  ApplicationStatus,
  GroupSnapshot,
  PluginSnapshot,
} from "./diagnostics";
export type {
  Application,
  CreateAppOptions,
  InstallHandle,
  PluginChangeSet,
  PluginContainer,
  PluginGroup,
  PluginHandle,
  PluginUpdate,
} from "./application-api";

interface RecordSnapshot {
  readonly id: string;
  readonly record: PluginRecord;
  readonly spec: InstallationSpec;
  readonly resolvedConfig: unknown;
}

type TransactionOutcome =
  | { readonly kind: "committed"; readonly records: ReadonlySet<PluginRecord> }
  | {
      readonly kind: "rolled-back";
      readonly records: ReadonlySet<PluginRecord>;
      readonly error: unknown;
    };

interface PreparedPluginRuntime {
  readonly record: PluginRecord;
  readonly runtime: PluginRuntime;
  readonly services: ReadonlyMap<string, unknown>;
}

interface GroupConfiguration {
  readonly draft: PluginChangeSetDraft;
  active: boolean;
  error: unknown;
}

interface GroupHost {
  install(group: GroupNode, plugin: AnyPlugin, config: unknown): PluginHandle;
  change(group: GroupNode): PluginChangeSetDraft;
  create(
    parent: GroupNode,
    name: string,
    configure: (group: PluginGroup) => void,
    inherited?: GroupConfiguration,
  ): PluginGroup;
  ready(group: GroupNode): Promise<void>;
  status(group: GroupNode): PluginStatus;
  remove(group: GroupNode): Promise<void>;
}

interface GroupHandleControl {
  finishConfiguration(): void;
  revoke(): void;
}

const groupHandleControls = new WeakMap<object, GroupHandleControl>();

class IncompletePluginCleanupError extends AggregateError {}

const defaultLogger: Logger = console;

type UnknownPluginUpdate = PluginUpdate<unknown, Requirements, Provisions, unknown>;

interface PluginHandleControl {
  attach(update: (change: UnknownPluginUpdate) => Promise<void>, remove: () => Promise<void>): void;
  revoke(): void;
}

const pluginHandleControls = new WeakMap<object, PluginHandleControl>();

class PluginHandleImpl<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> implements PluginHandle<Config, Requires, Provides, ConfigInput> {
  readonly #record: PluginRecord;
  #updateRecord:
    ((update: PluginUpdate<Config, Requires, Provides, ConfigInput>) => Promise<void>) | undefined;
  #removeRecord: (() => Promise<void>) | undefined;
  #state: "draft" | "attached" | "revoked" = "draft";

  constructor(record: PluginRecord) {
    this.#record = record;
    pluginHandleControls.set(this, {
      attach: (updateRecord, removeRecord) => {
        if (this.#state !== "draft") {
          throw new TypeError(`Plugin '${this.#record.id}' control is already sealed`);
        }
        this.#state = "attached";
        this.#updateRecord = updateRecord as (
          update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
        ) => Promise<void>;
        this.#removeRecord = removeRecord;
      },
      revoke: () => {
        this.#state = "revoked";
        this.#updateRecord = undefined;
        this.#removeRecord = undefined;
      },
    });
    Object.freeze(this);
  }

  get id() {
    return this.#record.id;
  }

  get group() {
    return this.#record.group.id;
  }

  get status() {
    return this.#record.status;
  }

  ready() {
    return this.#record.ready();
  }

  async update(update: PluginUpdate<Config, Requires, Provides, ConfigInput>) {
    if (this.#state === "draft") throw this.#notCommitted();
    const updateRecord = this.#updateRecord;
    if (!updateRecord) {
      throw (
        this.#record.error ??
        new DougongError("PLUGIN_REMOVED", `Plugin '${this.#record.id}' has been removed`)
      );
    }
    await updateRecord(update);
  }

  async remove() {
    if (this.#state === "draft") throw this.#notCommitted();
    const removeRecord = this.#removeRecord;
    if (removeRecord) await removeRecord();
  }

  #notCommitted() {
    return new DougongError(
      "PLUGIN_UNAVAILABLE",
      `Plugin '${this.#record.id}' installation has not been committed`,
    );
  }
}

class PluginGroupImpl implements PluginGroup {
  #host: GroupHost | undefined;
  readonly #node: GroupNode;
  #configuration: GroupConfiguration | undefined;

  constructor(host: GroupHost, node: GroupNode, configuration?: GroupConfiguration) {
    this.#host = host;
    this.#node = node;
    this.#configuration = configuration;
    groupHandleControls.set(this, {
      finishConfiguration: () => {
        if (!this.#configuration?.active) this.#configuration = undefined;
      },
      revoke: () => {
        this.#host = undefined;
        this.#configuration = undefined;
      },
    });
    Object.freeze(this);
  }

  get id() {
    return this.#node.id;
  }

  get name() {
    return this.#node.name;
  }

  get status() {
    return this.#host?.status(this.#node) ?? "removed";
  }

  ready() {
    const host = this.#host;
    return host
      ? host.ready(this.#node)
      : Promise.reject(new TypeError(`Group '${this.#node.id}' has been removed`));
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    if (this.#configuration?.active) {
      return this.#configuration.draft.install(plugin, ...config);
    }
    return this.#requireHost().install(
      this.#node,
      plugin as unknown as AnyPlugin,
      config[0],
    ) as PluginHandle<Config, Requires, Provides, ConfigInput>;
  }

  change() {
    if (this.#configuration?.active) {
      throw new TypeError("Cannot create a ChangeSet while a Group is being configured");
    }
    return this.#requireHost().change(this.#node);
  }

  group(name: string, configure: (group: PluginGroup) => void) {
    return this.#requireHost().create(this.#node, name, configure, this.#configuration);
  }

  remove() {
    if (this.#configuration?.active) {
      throw new TypeError("Cannot remove a Group while it is being configured");
    }
    return this.#host?.remove(this.#node) ?? Promise.resolve();
  }

  #requireHost() {
    const host = this.#host;
    if (!host) throw new TypeError(`Group '${this.#node.id}' has been removed`);
    return host;
  }
}

class ApplicationImpl implements Application {
  readonly name: string;
  readonly diagnostics: SnapshotView<ApplicationSnapshot>;

  readonly #records = new Map<string, PluginRecord>();
  readonly #services = new Map<PluginRecord, ReadonlyMap<string, unknown>>();
  readonly #contractKinds = new Map<string, ContractKind>();
  readonly #events = new EventHub();
  readonly #extensions: ExtensionRegistry;
  readonly #host: LifetimeHost;
  readonly #handles = new WeakMap<object, PluginRecord>();
  readonly #controls = new WeakMap<
    PluginRecord,
    PluginHandleImpl<unknown, Requirements, Provisions, unknown>
  >();
  readonly #diagnosticModel: ApplicationDiagnostics;
  readonly #logger: Logger;
  readonly #rootGroup: GroupNode;
  readonly #groupHost: GroupHost;
  readonly #groupHandles = new WeakMap<GroupNode, PluginGroupImpl>();
  readonly #groupOperations = new WeakMap<GroupNode, Promise<void>>();
  readonly #onError: (error: unknown) => void;

  #counter = 0;
  #status: ApplicationStatus = "idle";
  #activePlan: PluginGraph | undefined;
  #startOrder: PluginRecord[] = [];
  #queue: Promise<void> = Promise.resolve();

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
    this.#rootGroup = GroupNode.root(name);
    this.#extensions = new ExtensionRegistry((error) => this.#report(error));
    this.#diagnosticModel = new ApplicationDiagnostics(name, this.#rootGroup.walk(), (error) =>
      this.#report(error),
    );
    this.diagnostics = this.#diagnosticModel.view;
    this.#host = {
      stageOn: (ownerId, token, listener, release) => {
        return this.#stageOn(ownerId, token, listener, release);
      },
      emit: (ownerId, token, payload) => this.#emit(ownerId, token, payload),
      stageContribution: (ownerId, token, key, value, release) => {
        return this.#stageContribution(ownerId, token, key, value, release);
      },
      report: (error) => this.#report(error),
    };
    this.#groupHost = {
      install: (group, plugin, config) => this.#installInGroup(group, plugin, config),
      change: (group) => this.#changeInGroup(group),
      create: (parent, childName, configure, inherited) => {
        return this.#createChildGroup(parent, childName, configure, inherited);
      },
      ready: (group) => this.#readyGroup(group),
      status: (group) => this.#groupStatus(group),
      remove: (group) => this.#removeGroup(group),
    };
    Object.freeze(this);
  }

  get status() {
    return this.#status;
  }

  get<T>(token: Service<T>): T {
    this.#assertContract(token, "service");
    this.#rememberContract(token);
    if (this.#status !== "active") {
      throw new DougongError("SERVICE_UNAVAILABLE", "Application services are not active");
    }
    const provider = this.#requireActivePlan().provider(token.id);
    const services = provider ? this.#services.get(provider.instance) : undefined;
    if (!provider || !services?.has(token.id)) {
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    return services.get(token.id) as T;
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    return this.#installInGroup(this.#rootGroup, plugin, ...config);
  }

  #installInGroup<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    group: GroupNode,
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput> {
    const changes = this.#changeInGroup(group);
    const handle = changes.install(plugin, ...config);
    const operation = changes.commit();
    void operation.catch(() => undefined);
    return handle;
  }

  change(): PluginChangeSet {
    return this.#changeInGroup(this.#rootGroup);
  }

  #changeInGroup(group: GroupNode): PluginChangeSetDraft {
    group.assertAttached();
    return new PluginChangeSetDraft({
      create: (plugin, config) => this.#createDraft(group, plugin, config),
      resolve: (handle) => {
        const record = this.#resolveHandle(handle);
        if (!group.contains(record.group)) {
          throw new TypeError(`Plugin '${record.id}' is outside ChangeSet group '${group.id}'`);
        }
        return record;
      },
      execute: (operations) => {
        return this.#executeChanges(operations);
      },
      attach: (record) => this.#attachRecord(record),
      discard: (record, error) => this.#discardRecord(record, error),
    });
  }

  group(name: string, configure: (group: PluginGroup) => void) {
    return this.#createChildGroup(this.#rootGroup, name, configure);
  }

  #createChildGroup(
    parent: GroupNode,
    name: string,
    configure: (group: PluginGroup) => void,
    inherited?: GroupConfiguration,
  ) {
    if (typeof configure !== "function") throw new TypeError("Group configure must be a function");
    const node = parent.create(name);
    const ownConfiguration = !inherited?.active;
    const configuration: GroupConfiguration =
      ownConfiguration || !inherited
        ? { draft: this.#changeInGroup(node), active: true, error: undefined }
        : inherited;
    const group = new PluginGroupImpl(this.#groupHost, node, configuration);
    this.#groupHandles.set(node, group);

    try {
      const result = configure(group) as unknown;
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Group configure must be synchronous");
      }
      if (configuration.error !== undefined) throw configuration.error;
    } catch (error) {
      configuration.error = error;
      const removedGroups = node.walk();
      node.detach();
      this.#revokeGroups(removedGroups);
      if (ownConfiguration) {
        configuration.active = false;
        cancelPluginChangeSet(configuration.draft, error);
      }
      this.#publishDiagnostics();
      throw error;
    }

    if (ownConfiguration) {
      configuration.active = false;
      const operation = configuration.draft.commit();
      for (const child of node.walk()) {
        const childHandle = this.#groupHandles.get(child);
        if (childHandle) groupHandleControls.get(childHandle)?.finishConfiguration();
        this.#trackGroup(child, operation);
      }
      void operation.catch(() => undefined);
    }
    this.#publishDiagnostics();
    return group;
  }

  async #readyGroup(group: GroupNode) {
    group.assertAttached();
    await this.#groupOperations.get(group);
    const records = [...this.#records.values()].filter((record) => group.contains(record.group));
    await Promise.all(records.map((record) => record.ready()));
  }

  #groupStatus(group: GroupNode): PluginStatus {
    if (!group.attached) return "removed";
    const records = [...this.#records.values()].filter((record) => group.contains(record.group));
    if (records.some((record) => record.status === "failed")) return "failed";
    if (records.some((record) => record.status === "stopping")) return "stopping";
    if (records.length && records.every((record) => record.status === "active")) return "active";
    if (group.error !== undefined) return "failed";
    return records.length ? "pending" : "active";
  }

  #removeGroup(group: GroupNode) {
    if (group === this.#rootGroup) throw new TypeError("The root Group cannot be removed");
    if (!group.attached) {
      this.#revokeGroups([group]);
      return Promise.resolve();
    }
    return this.#enqueue(async () => {
      if (!group.attached) {
        this.#revokeGroups([group]);
        return;
      }
      const removedGroups = group.walk();
      const operations: ChangeOperation[] = [];
      for (const record of this.#records.values()) {
        if (group.contains(record.group)) operations.push({ kind: "remove", record });
      }
      if (operations.length && this.#status === "active") {
        await this.#transact(operations);
      } else {
        this.#applyChanges(operations);
        this.#settleChanges(operations);
      }
      group.detach();
      this.#revokeGroups(removedGroups);
      this.#publishDiagnostics();
    });
  }

  start() {
    return this.#enqueue(async () => {
      if (this.#status === "active") return;
      this.#setStatus("starting");
      try {
        const plan = this.#buildPlan();
        await this.#withExtensionBatch(() => this.#startPlan(plan));
        this.#activePlan = plan;
        this.#setStatus("active");
        this.#settleRecords(this.#startOrder);
      } catch (error) {
        this.#activePlan = undefined;
        this.#setStatus("idle");
        for (const record of this.#records.values()) {
          if (record.status !== "active") record.fail(error);
        }
        this.#settleRecords(this.#records.values());
        throw error;
      }
    });
  }

  stop() {
    return this.#enqueue(async () => {
      if (this.#status === "idle") return;
      this.#setStatus("stopping");
      const errors = await this.#withExtensionBatch(() =>
        this.#stopRecords(new Set(this.#startOrder)),
      );
      this.#activePlan = undefined;
      this.#setStatus("idle");
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Application shutdown failed");
    });
  }

  #createDraft(group: GroupNode, plugin: AnyPlugin, config: unknown) {
    group.assertAttached();
    const index = ++this.#counter;
    const id = `${plugin.name}:${index}`;
    const record = new PluginRecord(id, index, group, installation(plugin, config));
    const handle = new PluginHandleImpl<unknown, Requirements, Provisions, unknown>(record);
    this.#handles.set(handle, record);
    this.#controls.set(record, handle);
    return { record, handle };
  }

  #resolveHandle(handle: object) {
    const record = this.#handles.get(handle);
    if (!record) throw new TypeError("PluginHandle belongs to a different Application");
    return record;
  }

  #executeChanges(operations: ReadonlyArray<ChangeOperation>, afterCommit?: () => void) {
    const installed = operations
      .filter((operation): operation is Extract<ChangeOperation, { kind: "install" }> => {
        return operation.kind === "install";
      })
      .map((operation) => operation.record);

    return this.#enqueue(async () => {
      try {
        if (this.#status === "active") {
          await this.#transact(operations);
        } else {
          this.#applyChanges(operations);
          this.#settleChanges(operations);
        }
        afterCommit?.();
        this.#publishDiagnostics();
      } catch (error) {
        for (const record of installed) {
          if (this.#records.get(record.id) !== record) this.#discardRecord(record, error);
        }
        throw error;
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #withExtensionBatch<T>(operation: () => Promise<T>) {
    this.#extensions.beginBatch();
    try {
      return await operation();
    } finally {
      this.#extensions.endBatch();
    }
  }

  async #transact(operations: ReadonlyArray<ChangeOperation>) {
    const outcome = await this.#withExtensionBatch(() => this.#runTransaction(operations));
    this.#settleRecords(outcome.records);
    if (outcome.kind === "rolled-back") throw outcome.error;
    this.#settleChanges(operations);
  }

  async #runTransaction(operations: ReadonlyArray<ChangeOperation>): Promise<TransactionOutcome> {
    const snapshot = this.#snapshot();
    const previousPlan = this.#requireActivePlan();
    const changed = new Set(operations.map((operation) => operation.record));
    this.#setStatus("changing");

    let nextPlan: PluginGraph;
    let affected: ReadonlySet<PluginRecord>;
    let nextConfigs: ReadonlyMap<PluginRecord, unknown>;
    try {
      this.#applyChanges(operations);
      nextPlan = this.#buildPlan();
      affected = previousPlan.affectedWith(nextPlan, changed);
      nextConfigs = await this.#resolveConfigs(
        nextPlan.order.filter((record) => affected.has(record)),
      );
      this.#commitContractKinds(nextPlan.contractKinds);
    } catch (error) {
      this.#restore(snapshot);
      this.#setStatus("active");
      throw error;
    }

    const previousConfigs = new Map<PluginRecord, unknown>();
    for (const item of snapshot) {
      if (affected.has(item.record)) previousConfigs.set(item.record, item.resolvedConfig);
    }

    const stopErrors = await this.#stopRecords(affected);
    if (stopErrors.length) {
      return this.#failClosed(
        snapshot,
        stopErrors,
        "Plugin change could not cleanly stop the affected runtime",
      );
    }

    try {
      await this.#startRecords(nextPlan, affected, nextConfigs);
      this.#startOrder = nextPlan.order.slice();
      this.#activePlan = nextPlan;
      this.#setStatus("active");
      return Object.freeze({ kind: "committed", records: affected });
    } catch (changeError) {
      const nextStopErrors = await this.#stopRecords(affected);
      if (changeError instanceof IncompletePluginCleanupError || nextStopErrors.length) {
        return this.#failClosed(
          snapshot,
          [changeError, ...nextStopErrors],
          "Plugin change failed and its partial runtime could not be cleanly disposed",
        );
      }
      return this.#rollback(snapshot, previousPlan, affected, previousConfigs, [
        changeError,
        ...nextStopErrors,
      ]);
    }
  }

  #applyChanges(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "install") {
        operation.record.group.assertAttached();
        if (this.#records.has(operation.record.id)) {
          throw new TypeError(`Plugin '${operation.record.id}' is already installed`);
        }
        continue;
      }

      const installed = this.#records.get(operation.record.id) === operation.record;
      if (operation.kind === "remove" && !installed && operation.record.status === "removed") {
        continue;
      }
      if (!installed) {
        throw new DougongError(
          "PLUGIN_REMOVED",
          `Plugin '${operation.record.id}' has been removed`,
        );
      }
      if (
        operation.kind === "update" &&
        operation.plugin &&
        operation.plugin.name !== operation.record.spec.plugin.name
      ) {
        throw new DougongError(
          "PLUGIN_IDENTITY",
          `Plugin '${operation.record.id}' cannot change name from ` +
            `'${operation.record.spec.plugin.name}' to '${operation.plugin.name}'`,
        );
      }
    }

    for (const operation of operations) {
      if (operation.kind === "install") {
        this.#records.set(operation.record.id, operation.record);
      } else if (operation.kind === "update") {
        const plugin = operation.plugin ?? operation.record.spec.plugin;
        const config = operation.hasConfig ? operation.config : operation.record.spec.config;
        operation.record.reconfigure(installation(plugin, config));
      } else if (this.#records.get(operation.record.id) === operation.record) {
        this.#records.delete(operation.record.id);
      }
    }
  }

  #settleChanges(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "remove") {
        operation.record.remove();
        operation.record.settle();
        this.#revokeControl(operation.record);
      } else if (this.#status !== "active") operation.record.pending();
    }
  }

  #discardRecord(record: PluginRecord, error: unknown) {
    record.abandon(error);
    this.#revokeControl(record);
  }

  #attachRecord(record: PluginRecord) {
    const handle = this.#controls.get(record);
    if (!handle) throw new TypeError(`Plugin '${record.id}' has no control handle`);
    const control = pluginHandleControls.get(handle);
    if (!control) throw new TypeError(`Plugin '${record.id}' has no draft control`);
    record.attach(() => this.#publishDiagnostics());
    control.attach(
      (update) => this.#changeInGroup(record.group).update(handle, update).commit(),
      () => this.#changeInGroup(record.group).remove(handle).commit(),
    );
  }

  #revokeControl(record: PluginRecord) {
    const handle = this.#controls.get(record);
    if (handle) {
      pluginHandleControls.get(handle)?.revoke();
      pluginHandleControls.delete(handle);
    }
    this.#controls.delete(record);
  }

  #revokeGroups(groups: Iterable<GroupNode>) {
    for (const group of groups) {
      const handle = this.#groupHandles.get(group);
      if (handle) {
        groupHandleControls.get(handle)?.revoke();
        groupHandleControls.delete(handle);
      }
      this.#groupHandles.delete(group);
    }
  }

  #settleRecords(records: Iterable<PluginRecord>) {
    for (const record of records) record.settle();
  }

  async #failClosed(
    snapshot: ReadonlyArray<RecordSnapshot>,
    causes: ReadonlyArray<unknown>,
    message: string,
  ): Promise<never> {
    this.#restore(snapshot);
    const shutdownErrors = await this.#stopRecords(new Set(this.#startOrder));
    this.#activePlan = undefined;
    this.#setStatus("idle");
    throw new AggregateError([...causes, ...shutdownErrors], message);
  }

  async #rollback(
    snapshot: ReadonlyArray<RecordSnapshot>,
    previousPlan: PluginGraph,
    affected: ReadonlySet<PluginRecord>,
    previousConfigs: ReadonlyMap<PluginRecord, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<TransactionOutcome> {
    this.#restore(snapshot);
    try {
      await this.#startRecords(previousPlan, affected, previousConfigs);
      this.#startOrder = previousPlan.order.slice();
      this.#activePlan = previousPlan;
      this.#setStatus("active");
    } catch (rollbackError) {
      const shutdownErrors = await this.#stopRecords(new Set(this.#startOrder));
      this.#activePlan = undefined;
      this.#setStatus("idle");
      throw new AggregateError(
        [...causes, rollbackError, ...shutdownErrors],
        "Plugin change failed and the previous application could not be restored",
      );
    }
    const error =
      causes.length === 1 ? causes[0] : new AggregateError(causes, "Plugin change failed");
    return Object.freeze({ kind: "rolled-back", records: affected, error });
  }

  #snapshot(): RecordSnapshot[] {
    return [...this.#records].map(([id, record]) => ({
      id,
      record,
      spec: record.spec,
      resolvedConfig: record.runtime?.config,
    }));
  }

  #restore(snapshot: ReadonlyArray<RecordSnapshot>) {
    this.#records.clear();
    for (const item of snapshot) {
      item.record.reconfigure(item.spec);
      this.#records.set(item.id, item.record);
    }
  }

  #buildPlan() {
    return PluginGraph.build(this.#records.values(), this.#contractKinds);
  }

  #requireActivePlan() {
    if (!this.#activePlan) {
      throw new DougongError("SERVICE_UNAVAILABLE", "Application services are not active");
    }
    return this.#activePlan;
  }

  async #startPlan(plan: PluginGraph) {
    const records = new Set(plan.order);
    const configs = await this.#resolveConfigs(plan.order);
    this.#commitContractKinds(plan.contractKinds);
    this.#services.clear();
    this.#startOrder = [];
    try {
      await this.#startRecords(plan, records, configs);
      this.#startOrder = plan.order.slice();
    } catch (error) {
      const cleanupErrors = await this.#stopRecords(records);
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Application startup failed");
      }
      throw error;
    }
  }

  async #startRecords(
    plan: PluginGraph,
    records: ReadonlySet<PluginRecord>,
    configs: ReadonlyMap<PluginRecord, unknown>,
  ) {
    for (const layer of plan.layers) {
      const candidates = layer.filter((record) => records.has(record) && !record.runtime);
      if (!candidates.length) continue;

      const controller = new AbortController();
      const results = await Promise.allSettled(
        candidates.map(async (record) => {
          try {
            const config = configs.has(record)
              ? configs.get(record)
              : await this.#resolveConfig(record.spec.plugin.config, record.spec.config);
            return await this.#prepareRecord(plan, record, config, controller.signal);
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        }),
      );

      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      const prepared = results
        .filter(
          (result): result is PromiseFulfilledResult<PreparedPluginRuntime> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      if (errors.length) {
        const cleanupErrors = await this.#disposePrepared(prepared);
        const startupError =
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Plugin startup layer failed");
        if (cleanupErrors.length) {
          throw new IncompletePluginCleanupError(
            [startupError, ...cleanupErrors],
            "Plugin startup layer failed and could not be cleanly disposed",
          );
        }
        throw startupError;
      }

      for (const candidate of prepared) this.#commitPrepared(candidate);
    }
  }

  async #prepareRecord(
    plan: PluginGraph,
    record: PluginRecord,
    config: unknown,
    startupSignal: AbortSignal,
  ): Promise<PreparedPluginRuntime> {
    record.pending();
    const plugin = record.spec.plugin;
    const lifetime = new Lifetime(this.#host, record.id, startupSignal);

    try {
      const requirements = this.#resolveRequirements(plan, record, plugin, lifetime);
      const meta: PluginMeta = {
        app: this.name,
        name: plugin.name,
        instance: record.id,
        group: record.group.id,
      };
      const context = this.#createContext(lifetime, meta, requirements);
      const output = await plugin.setup(context, config);
      const services = new Map<string, unknown>();
      for (const [alias, token] of Object.entries(plugin.provides ?? {})) {
        if (typeof output !== "object" || output === null || !Object.hasOwn(output, alias)) {
          throw new DougongError(
            "SERVICE_NOT_RETURNED",
            `Plugin '${record.id}' did not return provided service '${alias}'`,
          );
        }
        services.set(token.id, (output as Record<string, unknown>)[alias]);
      }

      return Object.freeze({
        record,
        runtime: Object.freeze({ plugin, config, lifetime }),
        services,
      });
    } catch (error) {
      record.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        throw new IncompletePluginCleanupError(
          [error, cleanupError],
          `Plugin '${record.id}' failed to start and could not be cleanly disposed`,
        );
      }
      throw error;
    }
  }

  #commitPrepared(candidate: PreparedPluginRuntime) {
    const { record, runtime, services } = candidate;
    this.#services.set(record, services);
    runtime.lifetime.publish();
    runtime.lifetime.detachParentSignal();
    record.activate(runtime);
    this.#startOrder.push(record);
  }

  async #disposePrepared(candidates: ReadonlyArray<PreparedPluginRuntime>) {
    const errors: unknown[] = [];
    for (const candidate of [...candidates].reverse()) {
      try {
        await candidate.runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #stopRecords(records: ReadonlySet<PluginRecord>) {
    const errors: unknown[] = [];
    const order = this.#startOrder.filter((record) => records.has(record)).reverse();
    this.#startOrder = this.#startOrder.filter((record) => !records.has(record));
    for (const record of order) {
      const runtime = record.runtime;
      if (!runtime) continue;
      record.beginStopping();
      this.#services.delete(record);
      try {
        await runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        record.pending();
      }
    }
    return errors;
  }

  async #resolveConfigs(records: ReadonlyArray<PluginRecord>) {
    const configs = new Map<PluginRecord, unknown>();
    for (const record of records) {
      configs.set(record, await this.#resolveConfig(record.spec.plugin.config, record.spec.config));
    }
    return configs;
  }

  #resolveRequirements(
    plan: PluginGraph,
    record: PluginRecord,
    plugin: AnyPlugin,
    lifetime: Lifetime,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = Object.create(null);
    for (const [alias, requirement] of Object.entries(plugin.requires ?? {})) {
      if (requirement.kind === "optional") {
        const provider = plan.providerFor(record, requirement.service.id);
        values[alias] = provider
          ? this.#services.get(provider.instance)?.get(requirement.service.id)
          : undefined;
      } else if (requirement.kind === "service") {
        const provider = plan.providerFor(record, requirement.id);
        const services = provider ? this.#services.get(provider.instance) : undefined;
        if (!provider || !services?.has(requirement.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Service '${requirement.id}' is not active for plugin '${record.id}'`,
          );
        }
        values[alias] = services.get(requirement.id);
      } else {
        values[alias] = this.#extensionView(requirement, lifetime);
      }
    }
    return values;
  }

  #createContext(
    lifetime: Lifetime,
    meta: PluginMeta,
    requirements: Record<string, unknown>,
  ): PluginContext<Requirements> {
    return Object.freeze({
      ...requirements,
      signal: lifetime.signal,
      meta: Object.freeze(meta),
      log: this.#logger,
      cleanup: lifetime.cleanup.bind(lifetime),
      lifetime: lifetime.lifetime.bind(lifetime),
      spawn: lifetime.spawn.bind(lifetime),
      on: lifetime.on.bind(lifetime),
      emit: lifetime.emit.bind(lifetime),
      contribute: lifetime.contribute.bind(lifetime),
    }) as PluginContext<Requirements>;
  }

  async #resolveConfig(schema: StandardSchemaV1<unknown, unknown> | undefined, config: unknown) {
    if (!schema) return config;
    const result = await schema["~standard"].validate(config);
    if (result.issues) {
      throw new ConfigValidationError(
        result.issues.map((issue) => ({
          message: issue.message,
          ...(issue.path ? { path: issue.path } : {}),
        })) as ValidationIssue[],
      );
    }
    return result.value;
  }

  #stageOn<T>(
    ownerId: string,
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ) {
    this.#assertOwner(ownerId);
    this.#rememberContract(token);
    return this.#events.stage(token.id, listener, release);
  }

  #emit<T>(ownerId: string, token: Event<T>, payload: T) {
    this.#assertOwner(ownerId);
    this.#rememberContract(token);
    return this.#events.emit(token.id, payload);
  }

  #stageContribution<T>(
    ownerId: string,
    token: Extension<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ) {
    this.#assertOwner(ownerId);
    this.#rememberContract(token);
    return this.#extensions.get(token).stage(ownerId, key, value, release);
  }

  #extensionView<T>(token: Extension<T>, lifetime: Lifetime): ExtensionView<T> {
    return this.#extensions.get(token).view((resource, kind) => lifetime.ownLease(resource, kind));
  }

  #assertOwner(ownerId: string) {
    if (!this.#records.has(ownerId)) throw new TypeError(`Plugin '${ownerId}' is not installed`);
  }

  #rememberContract(token: { readonly id: string; readonly kind: ContractKind }) {
    this.#assertContract(token);
    const previous = this.#contractKinds.get(token.id);
    if (previous && previous !== token.kind) {
      throw new DougongError(
        "CONTRACT_CONFLICT",
        `Contract '${token.id}' is used as both '${previous}' and '${token.kind}'`,
      );
    }
    this.#contractKinds.set(token.id, token.kind);
  }

  #assertContract(
    token: { readonly id?: unknown; readonly kind?: unknown },
    expected?: ContractKind,
  ): asserts token is { readonly id: string; readonly kind: ContractKind } {
    if (
      !token ||
      typeof token !== "object" ||
      typeof token.id !== "string" ||
      !token.id.trim() ||
      token.id !== token.id.trim() ||
      !["service", "extension", "event"].includes(token.kind as string) ||
      (expected !== undefined && token.kind !== expected)
    ) {
      throw new TypeError(expected ? `Expected a ${expected} contract` : "Invalid contract");
    }
  }

  #commitContractKinds(kinds: ReadonlyMap<string, ContractKind>) {
    for (const [id, kind] of kinds) this.#contractKinds.set(id, kind);
  }

  #trackGroup(group: GroupNode, operation: Promise<void>) {
    const tracked = operation.then(
      () => {
        group.recover();
      },
      (error) => {
        group.fail(error);
        this.#publishDiagnostics();
        throw error;
      },
    );
    this.#groupOperations.set(group, tracked);
    void tracked.catch(() => undefined);
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
    this.#diagnosticModel.publish(this.#status, this.#records.values(), this.#rootGroup.walk());
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && "then" in value
  );
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
