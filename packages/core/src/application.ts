import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  Application,
  CreateAppOptions,
  PluginChangeSet,
  PluginGroup,
  PluginHandle,
  PluginUpdate,
} from "./application-api";
import {
  discardPluginChangeSetDraft,
  PluginChangeSetDraft,
  type PluginChangeOperation,
} from "./change-set";
import { ContractRegistry, type ContractRegistryDraft } from "./contract-registry";
import { assertContract, type Event, type Extension, type Service } from "./contracts";
import {
  ApplicationDiagnostics,
  type ApplicationSnapshot,
  type ApplicationStatus,
} from "./diagnostics";
import {
  ConfigValidationError,
  DougongError,
  normalizeFailure,
  type ValidationIssue,
} from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import { ExtensionRegistry, type ExtensionView } from "./extension-store";
import { GroupConfigurationSession, GroupNode } from "./group";
import { groupRemovedError, GroupLifecycle } from "./group-lifecycle";
import { Lifetime, type LifetimeHost, type Logger, type PluginMeta } from "./lifetime";
import { PluginGraph } from "./plugin-graph";
import {
  type AnyPlugin,
  createInstallationSpec,
  type InstallationSpec,
  PluginInstallation,
  type PluginRuntime,
  type InstallationStatus,
} from "./plugin-installation";
import type { PluginContext, PluginDefinition, Provisions, Requirements } from "./plugin";
import type { Publication } from "./resource";
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
  readonly resolvedConfig: unknown;
}

type TransactionOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<PluginInstallation> }
  | {
      readonly kind: "rolled-back";
      readonly affected: ReadonlySet<PluginInstallation>;
      readonly error: unknown;
    };

interface PreparedActivation {
  readonly installation: PluginInstallation;
  readonly runtime: PluginRuntime;
  readonly services: ReadonlyMap<string, unknown>;
}

interface GroupHost {
  install(group: GroupNode, plugin: AnyPlugin, config: unknown): PluginHandle;
  change(group: GroupNode): PluginChangeSetDraft;
  create(
    parent: GroupNode,
    name: string,
    configure: (group: PluginGroup) => void,
    inherited?: GroupConfigurationSession<PluginChangeSetDraft>,
  ): PluginGroup;
  ready(group: GroupNode): Promise<void>;
  status(group: GroupNode): InstallationStatus;
  remove(group: GroupNode): Promise<void>;
}

interface GroupHandleControl {
  finishConfiguration(): void;
  revoke(): void;
}

const groupHandleControls = new WeakMap<object, GroupHandleControl>();

type PluginGroupState =
  | {
      readonly phase: "configuring";
      readonly host: GroupHost;
      readonly configuration: GroupConfigurationSession<PluginChangeSetDraft>;
    }
  | { readonly phase: "attached"; readonly host: GroupHost }
  | { readonly phase: "revoked" };

class IncompletePluginCleanupError extends AggregateError {}

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

class PluginGroupImpl implements PluginGroup {
  readonly #node: GroupNode;
  #state: PluginGroupState;

  constructor(
    host: GroupHost,
    node: GroupNode,
    configuration?: GroupConfigurationSession<PluginChangeSetDraft>,
  ) {
    this.#node = node;
    this.#state = configuration
      ? { phase: "configuring", host, configuration }
      : { phase: "attached", host };
    groupHandleControls.set(this, {
      finishConfiguration: () => {
        const state = this.#state;
        if (state.phase === "configuring") {
          this.#state = { phase: "attached", host: state.host };
        }
      },
      revoke: () => {
        this.#state = { phase: "revoked" };
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
    const state = this.#state;
    return state.phase === "revoked" ? "removed" : state.host.status(this.#node);
  }

  ready() {
    const state = this.#state;
    return state.phase === "revoked"
      ? Promise.reject(groupRemovedError(this.#node))
      : state.host.ready(this.#node);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    const state = this.#state;
    if (state.phase === "configuring") {
      return state.configuration.requireDraft().install(plugin, ...config);
    }
    return this.#requireHost().install(
      this.#node,
      plugin as unknown as AnyPlugin,
      config[0],
    ) as PluginHandle<Config, Requires, Provides, ConfigInput>;
  }

  change() {
    if (this.#state.phase === "configuring") {
      throw new TypeError("Cannot create a ChangeSet while a Group is being configured");
    }
    return this.#requireHost().change(this.#node);
  }

  group(name: string, configure: (group: PluginGroup) => void) {
    const state = this.#state;
    if (state.phase === "configuring") state.configuration.assertOpen();
    return this.#requireHost().create(
      this.#node,
      name,
      configure,
      state.phase === "configuring" ? state.configuration : undefined,
    );
  }

  remove() {
    const state = this.#state;
    if (state.phase === "configuring") {
      throw new TypeError("Cannot remove a Group while it is being configured");
    }
    return state.phase === "attached" ? state.host.remove(this.#node) : Promise.resolve();
  }

  #requireHost() {
    const state = this.#state;
    if (state.phase === "revoked") {
      throw groupRemovedError(this.#node);
    }
    return state.host;
  }
}

class ApplicationImpl implements Application {
  readonly name: string;
  readonly diagnostics: SnapshotView<ApplicationSnapshot>;

  readonly #installations = new Map<string, PluginInstallation>();
  readonly #servicesByInstallation = new Map<PluginInstallation, ReadonlyMap<string, unknown>>();
  readonly #contractRegistry = new ContractRegistry();
  readonly #eventHub = new EventHub();
  readonly #extensionRegistry: ExtensionRegistry;
  readonly #ownedPluginHandles = new WeakMap<object, PluginInstallation>();
  readonly #pluginControlHandles = new WeakMap<
    PluginInstallation,
    PluginHandleImpl<unknown, Requirements, Provisions, unknown>
  >();
  readonly #diagnosticModel: ApplicationDiagnostics;
  readonly #logger: Logger;
  readonly #rootGroup: GroupNode;
  readonly #groupHost: GroupHost;
  readonly #groupHandles = new WeakMap<GroupNode, PluginGroupImpl>();
  readonly #groupLifecycles = new WeakMap<GroupNode, GroupLifecycle>();
  readonly #onError: (error: unknown) => void;

  #installationSequence = 0;
  #status: ApplicationStatus = "idle";
  #activeGraph: PluginGraph | undefined;
  #activationOrder: PluginInstallation[] = [];
  #commandQueue: Promise<void> = Promise.resolve();

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
    this.#extensionRegistry = new ExtensionRegistry((error) => this.#report(error));
    this.#diagnosticModel = new ApplicationDiagnostics(name, this.#rootGroup.walk(), (error) =>
      this.#report(error),
    );
    this.#groupLifecycles.set(
      this.#rootGroup,
      new GroupLifecycle(this.#rootGroup, true, () => this.#publishDiagnostics()),
    );
    this.diagnostics = this.#diagnosticModel.view;
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
    assertContract(token, "service");
    this.#contractRegistry.assertCompatible(token);
    if (this.#status !== "active") {
      throw new DougongError("SERVICE_UNAVAILABLE", "Application services are not active");
    }
    const provider = this.#requireActiveGraph().provider(token.id);
    const services = provider ? this.#servicesByInstallation.get(provider) : undefined;
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

  #changeInGroup(group: GroupNode, trackChanges = true): PluginChangeSetDraft {
    group.assertAttached();
    return new PluginChangeSetDraft({
      create: (plugin, config) => this.#createDraft(group, plugin, config),
      resolve: (handle) => {
        const installation = this.#resolveHandle(handle);
        if (!group.containsId(installation.groupId)) {
          throw new TypeError(
            `Plugin '${installation.id}' is outside ChangeSet group '${group.id}'`,
          );
        }
        return installation;
      },
      execute: (operations) => {
        const operation = this.#executeChanges(operations);
        for (const change of operations) change.installation.trackReadiness(operation);
        if (trackChanges) this.#trackGroup(group, operation);
        return operation;
      },
      attach: (installation) => this.#attachInstallation(installation),
      discard: (installation, error) => this.#discardInstallation(installation, error),
    });
  }

  group(name: string, configure: (group: PluginGroup) => void) {
    return this.#createChildGroup(this.#rootGroup, name, configure);
  }

  #createChildGroup(
    parent: GroupNode,
    name: string,
    configure: (group: PluginGroup) => void,
    inherited?: GroupConfigurationSession<PluginChangeSetDraft>,
  ) {
    if (typeof configure !== "function") throw new TypeError("Group configure must be a function");
    const node = parent.create(name);
    this.#groupLifecycles.set(
      node,
      new GroupLifecycle(node, false, () => this.#publishDiagnostics()),
    );
    const ownConfiguration = inherited === undefined;
    const configuration =
      inherited ??
      new GroupConfigurationSession(
        this.#changeInGroup(node, false),
        discardPluginChangeSetDraft,
        (error) =>
          normalizeFailure(
            error,
            "GROUP_UNAVAILABLE",
            `Group '${node.id}' configuration failed with a non-Error value`,
          ),
      );
    const group = new PluginGroupImpl(this.#groupHost, node, configuration);
    this.#groupHandles.set(node, group);

    try {
      const result: unknown = configure(group);
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Group configure must be synchronous");
      }
      const failure = configuration.failure;
      if (failure) throw failure;
    } catch (error) {
      const failure = configuration.fail(error);
      const removedGroups = node.walk();
      node.detach();
      this.#revokeGroups(removedGroups);
      if (ownConfiguration) configuration.discard(failure);
      this.#publishDiagnostics();
      throw failure;
    }

    if (ownConfiguration) {
      const operation = configuration.seal().commit();
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
    await this.#requireGroupLifecycle(group).ready(async () => {
      const installations = this.#installationsInGroup(group);
      await Promise.all(installations.map((installation) => installation.ready()));
    });
  }

  #groupStatus(group: GroupNode): InstallationStatus {
    if (!group.attached) return "removed";
    return this.#requireGroupLifecycle(group).status(this.#installationStatusInGroup(group));
  }

  #installationsInGroup(group: GroupNode) {
    return [...this.#installations.values()].filter((installation) =>
      group.containsId(installation.groupId),
    );
  }

  #installationStatusInGroup(group: GroupNode): InstallationStatus {
    const installations = this.#installationsInGroup(group);
    if (installations.some((installation) => installation.status === "failed")) return "failed";
    if (installations.some((installation) => installation.status === "stopping")) return "stopping";
    if (
      installations.length &&
      installations.every((installation) => installation.status === "active")
    ) {
      return "active";
    }
    return installations.length ? "pending" : "active";
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
      const operations: PluginChangeOperation[] = [];
      for (const installation of this.#installations.values()) {
        if (group.containsId(installation.groupId))
          operations.push({ kind: "remove", installation });
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
      let contracts: ContractRegistryDraft | undefined;
      try {
        const plan = this.#buildGraph();
        const contractDraft = this.#contractRegistry.draft(plan.contractKinds);
        contracts = contractDraft;
        await this.#withExtensionBatch(() => this.#activateGraph(plan, contractDraft));
        this.#activeGraph = plan;
        this.#setStatus("active");
        this.#settleInstallations(this.#activationOrder);
      } catch (error) {
        contracts?.discard();
        this.#activeGraph = undefined;
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
    return this.#enqueue(async () => {
      if (this.#status === "idle") return;
      this.#setStatus("stopping");
      const errors = await this.#withExtensionBatch(() =>
        this.#deactivateInstallations(new Set(this.#activationOrder)),
      );
      this.#activeGraph = undefined;
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

    return this.#enqueue(async () => {
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

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#commandQueue.then(operation, operation);
    this.#commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #withExtensionBatch<T>(operation: () => Promise<T>) {
    this.#extensionRegistry.beginBatch();
    try {
      return await operation();
    } finally {
      this.#extensionRegistry.endBatch();
    }
  }

  async #transact(operations: ReadonlyArray<PluginChangeOperation>) {
    const outcome = await this.#withExtensionBatch(() => this.#runTransaction(operations));
    this.#settleInstallations(outcome.affected);
    if (outcome.kind === "rolled-back") throw outcome.error;
    this.#settleChanges(operations);
  }

  async #runTransaction(
    operations: ReadonlyArray<PluginChangeOperation>,
  ): Promise<TransactionOutcome> {
    const snapshot = this.#captureInstallations();
    const previousPlan = this.#requireActiveGraph();
    const changed = new Set(operations.map((operation) => operation.installation));
    this.#setStatus("changing");

    let nextPlan: PluginGraph;
    let affected: ReadonlySet<PluginInstallation>;
    let nextConfigs: ReadonlyMap<PluginInstallation, unknown>;
    let contracts: ContractRegistryDraft;
    try {
      this.#applyChanges(operations);
      nextPlan = this.#buildGraph();
      affected = previousPlan.affectedByTransitionTo(nextPlan, changed);
      nextConfigs = await this.#resolveConfigs(
        nextPlan.order.filter((installation) => affected.has(installation)),
      );
      contracts = this.#contractRegistry.draft(nextPlan.contractKinds);
    } catch (error) {
      this.#restoreInstallations(snapshot);
      this.#setStatus("active");
      throw error;
    }

    const previousConfigs = new Map<PluginInstallation, unknown>();
    for (const item of snapshot) {
      if (affected.has(item.installation))
        previousConfigs.set(item.installation, item.resolvedConfig);
    }

    const stopErrors = await this.#deactivateInstallations(affected);
    if (stopErrors.length) {
      contracts.discard();
      return this.#failClosed(
        snapshot,
        stopErrors,
        "Plugin change could not cleanly stop the affected runtime",
      );
    }

    try {
      await this.#activateInstallations(nextPlan, affected, nextConfigs, contracts);
      contracts.commit();
      this.#activationOrder = nextPlan.order.slice();
      this.#activeGraph = nextPlan;
      this.#setStatus("active");
      return Object.freeze({ kind: "committed", affected });
    } catch (changeError) {
      const nextStopErrors = await this.#deactivateInstallations(affected);
      contracts.discard();
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
        operation.plugin &&
        operation.plugin.name !== operation.installation.spec.plugin.name
      ) {
        throw new DougongError(
          "PLUGIN_IDENTITY",
          `Plugin '${operation.installation.id}' cannot change name from ` +
            `'${operation.installation.spec.plugin.name}' to '${operation.plugin.name}'`,
        );
      }
    }

    for (const operation of operations) {
      if (operation.kind === "install") {
        this.#installations.set(operation.installation.id, operation.installation);
      } else if (operation.kind === "update") {
        const plugin = operation.plugin ?? operation.installation.spec.plugin;
        const config = operation.hasConfig ? operation.config : operation.installation.spec.config;
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
      (update) => this.#changeInGroup(installation.group).update(handle, update).commit(),
      () => this.#changeInGroup(installation.group).remove(handle).commit(),
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

  #revokeGroups(groups: Iterable<GroupNode>) {
    for (const group of groups) {
      this.#groupLifecycles.get(group)?.release();
      this.#groupLifecycles.delete(group);
      const handle = this.#groupHandles.get(group);
      if (handle) {
        groupHandleControls.get(handle)?.revoke();
        groupHandleControls.delete(handle);
      }
      this.#groupHandles.delete(group);
    }
  }

  #settleInstallations(installations: Iterable<PluginInstallation>) {
    for (const installation of installations) installation.settleReady();
  }

  async #failClosed(
    snapshot: ReadonlyArray<InstallationSnapshot>,
    causes: ReadonlyArray<unknown>,
    message: string,
  ): Promise<never> {
    this.#restoreInstallations(snapshot);
    const shutdownErrors = await this.#deactivateInstallations(new Set(this.#activationOrder));
    this.#activeGraph = undefined;
    this.#setStatus("idle");
    throw new AggregateError([...causes, ...shutdownErrors], message);
  }

  async #rollback(
    snapshot: ReadonlyArray<InstallationSnapshot>,
    previousPlan: PluginGraph,
    affected: ReadonlySet<PluginInstallation>,
    previousConfigs: ReadonlyMap<PluginInstallation, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<TransactionOutcome> {
    this.#restoreInstallations(snapshot);
    const contracts = this.#contractRegistry.draft(previousPlan.contractKinds);
    try {
      await this.#activateInstallations(previousPlan, affected, previousConfigs, contracts);
      contracts.commit();
      this.#activationOrder = previousPlan.order.slice();
      this.#activeGraph = previousPlan;
      this.#setStatus("active");
    } catch (rollbackError) {
      const shutdownErrors = await this.#deactivateInstallations(new Set(this.#activationOrder));
      contracts.discard();
      this.#activeGraph = undefined;
      this.#setStatus("idle");
      throw new AggregateError(
        [...causes, rollbackError, ...shutdownErrors],
        "Plugin change failed and the previous application could not be restored",
      );
    }
    const error =
      causes.length === 1 ? causes[0] : new AggregateError(causes, "Plugin change failed");
    return Object.freeze({ kind: "rolled-back", affected, error });
  }

  #captureInstallations(): InstallationSnapshot[] {
    return [...this.#installations].map(([id, installation]) => ({
      id,
      installation,
      spec: installation.spec,
      resolvedConfig: installation.runtime?.config,
    }));
  }

  #restoreInstallations(snapshot: ReadonlyArray<InstallationSnapshot>) {
    this.#installations.clear();
    for (const item of snapshot) {
      item.installation.reconfigure(item.spec);
      this.#installations.set(item.id, item.installation);
    }
  }

  #buildGraph() {
    return PluginGraph.build(this.#installations.values(), this.#contractRegistry.kinds);
  }

  #requireActiveGraph() {
    if (!this.#activeGraph) {
      throw new DougongError("SERVICE_UNAVAILABLE", "Application services are not active");
    }
    return this.#activeGraph;
  }

  async #activateGraph(plan: PluginGraph, contracts: ContractRegistryDraft) {
    const installations = new Set(plan.order);
    const configs = await this.#resolveConfigs(plan.order);
    this.#servicesByInstallation.clear();
    this.#activationOrder = [];
    try {
      await this.#activateInstallations(plan, installations, configs, contracts);
      contracts.commit();
      this.#activationOrder = plan.order.slice();
    } catch (error) {
      const cleanupErrors = await this.#deactivateInstallations(installations);
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Application startup failed");
      }
      throw error;
    }
  }

  async #activateInstallations(
    plan: PluginGraph,
    installations: ReadonlySet<PluginInstallation>,
    configs: ReadonlyMap<PluginInstallation, unknown>,
    contracts: ContractRegistryDraft,
  ) {
    const host = this.#createLifetimeHost(contracts);
    for (const layer of plan.layers) {
      const candidates = layer.filter(
        (installation) => installations.has(installation) && !installation.runtime,
      );
      if (!candidates.length) continue;

      const controller = new AbortController();
      const results = await Promise.allSettled(
        candidates.map(async (installation) => {
          try {
            const config = configs.has(installation)
              ? configs.get(installation)
              : await this.#resolveConfig(
                  installation.spec.plugin.config,
                  installation.spec.config,
                );
            return await this.#prepareActivation(
              plan,
              installation,
              config,
              controller.signal,
              host,
            );
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
          (result): result is PromiseFulfilledResult<PreparedActivation> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      if (errors.length) {
        const cleanupErrors = await this.#disposePreparedActivations(prepared);
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

      for (const candidate of prepared) this.#commitActivation(candidate);
    }
  }

  async #prepareActivation(
    plan: PluginGraph,
    installation: PluginInstallation,
    config: unknown,
    startupSignal: AbortSignal,
    host: LifetimeHost,
  ): Promise<PreparedActivation> {
    installation.deactivate();
    const plugin = installation.spec.plugin;
    const lifetime = new Lifetime(host, installation.id, { parentSignal: startupSignal });

    try {
      const requirements = this.#resolveRequirements(plan, installation, plugin, lifetime);
      const meta: PluginMeta = {
        applicationName: this.name,
        pluginName: plugin.name,
        installationId: installation.id,
        groupId: installation.groupId,
      };
      const context = this.#createContext(lifetime, meta, requirements);
      const output = await plugin.setup(context, config);
      const services = new Map<string, unknown>();
      for (const [alias, token] of Object.entries(plugin.provides ?? {})) {
        if (typeof output !== "object" || output === null || !Object.hasOwn(output, alias)) {
          throw new DougongError(
            "SERVICE_NOT_RETURNED",
            `Plugin '${installation.id}' did not return provided service '${alias}'`,
          );
        }
        services.set(token.id, (output as Record<string, unknown>)[alias]);
      }

      return Object.freeze({
        installation,
        runtime: Object.freeze({ plugin, config, lifetime }),
        services,
      });
    } catch (error) {
      installation.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        throw new IncompletePluginCleanupError(
          [error, cleanupError],
          `Plugin '${installation.id}' failed to start and could not be cleanly disposed`,
        );
      }
      throw error;
    }
  }

  #commitActivation(candidate: PreparedActivation) {
    const { installation, runtime, services } = candidate;
    this.#servicesByInstallation.set(installation, services);
    runtime.lifetime.publish();
    runtime.lifetime.detachStartupSignal();
    installation.activate(runtime);
    this.#activationOrder.push(installation);
  }

  async #disposePreparedActivations(candidates: ReadonlyArray<PreparedActivation>) {
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

  async #deactivateInstallations(installations: ReadonlySet<PluginInstallation>) {
    const errors: unknown[] = [];
    const order = this.#activationOrder
      .filter((installation) => installations.has(installation))
      .reverse();
    this.#activationOrder = this.#activationOrder.filter(
      (installation) => !installations.has(installation),
    );
    for (const installation of order) {
      const runtime = installation.runtime;
      if (!runtime) continue;
      installation.beginStopping();
      this.#servicesByInstallation.delete(installation);
      try {
        await runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        installation.deactivate();
      }
    }
    return errors;
  }

  async #resolveConfigs(installations: ReadonlyArray<PluginInstallation>) {
    const configs = new Map<PluginInstallation, unknown>();
    for (const installation of installations) {
      configs.set(
        installation,
        await this.#resolveConfig(installation.spec.plugin.config, installation.spec.config),
      );
    }
    return configs;
  }

  #resolveRequirements(
    plan: PluginGraph,
    installation: PluginInstallation,
    plugin: AnyPlugin,
    lifetime: Lifetime,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = Object.create(null);
    for (const [alias, requirement] of Object.entries(plugin.requires ?? {})) {
      if (requirement.kind === "optional") {
        const provider = plan.providerFor(installation, requirement.service.id);
        if (!provider) {
          values[alias] = undefined;
          continue;
        }
        const services = this.#servicesByInstallation.get(provider);
        if (!services?.has(requirement.service.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Optional service '${requirement.service.id}' is not active for plugin '${installation.id}'`,
          );
        }
        values[alias] = services.get(requirement.service.id);
      } else if (requirement.kind === "service") {
        const provider = plan.providerFor(installation, requirement.id);
        const services = provider ? this.#servicesByInstallation.get(provider) : undefined;
        if (!provider || !services?.has(requirement.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Service '${requirement.id}' is not active for plugin '${installation.id}'`,
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

  #createLifetimeHost(contracts: ContractRegistryDraft): LifetimeHost {
    return {
      stageOn: (ownerId, token, listener, release) => {
        return this.#stageOn(ownerId, token, listener, release, contracts);
      },
      emit: (ownerId, token, payload) => this.#emit(ownerId, token, payload, contracts),
      stageContribution: (ownerId, token, key, value, release) => {
        return this.#stageContribution(ownerId, token, key, value, release, contracts);
      },
      report: (error) => this.#report(error),
    };
  }

  #stageOn<T>(
    ownerId: string,
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
    contracts: ContractRegistryDraft,
  ) {
    this.#assertOwner(ownerId);
    assertContract(token, "event");
    contracts.remember(token);
    return this.#eventHub.stage(token.id, listener, release);
  }

  #emit<T>(ownerId: string, token: Event<T>, payload: T, contracts: ContractRegistryDraft) {
    this.#assertOwner(ownerId);
    assertContract(token, "event");
    contracts.remember(token);
    return this.#eventHub.emit(token.id, payload);
  }

  #stageContribution<T>(
    ownerId: string,
    token: Extension<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
    contracts: ContractRegistryDraft,
  ) {
    this.#assertOwner(ownerId);
    assertContract(token, "extension");
    contracts.remember(token);
    return this.#extensionRegistry.get(token).stage(ownerId, key, value, release);
  }

  #extensionView<T>(token: Extension<T>, lifetime: Lifetime): ExtensionView<T> {
    return this.#extensionRegistry
      .get(token)
      .view((resource, kind) => lifetime.ownLease(resource, kind));
  }

  #assertOwner(ownerId: string) {
    if (!this.#installations.has(ownerId))
      throw new TypeError(`Plugin '${ownerId}' is not installed`);
  }

  #trackGroup(group: GroupNode, operation: Promise<void>) {
    this.#requireGroupLifecycle(group).track(operation);
  }

  #requireGroupLifecycle(group: GroupNode) {
    const lifecycle = this.#groupLifecycles.get(group);
    if (!lifecycle) throw groupRemovedError(group);
    return lifecycle;
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
    this.#diagnosticModel.publish(
      this.#status,
      this.#installations.values(),
      this.#rootGroup.walk(),
    );
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
