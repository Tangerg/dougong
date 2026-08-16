import type { Group, Installation } from "./host-api";
import { discardChangeSetDraft, ChangeSetDraft, type ChangeOperation } from "./change-set";
import { normalizeFailure } from "./errors";
import { GroupConfigurationSession, GroupNode } from "./group";
import { groupRemovedError, GroupLifecycle } from "./group-lifecycle";
import type { InstallationRecord } from "./installation";
import type { LifecycleStatus } from "./lifecycle-status";
import type { ErasedPlugin, Plugin, Provisions, Requirements } from "./plugin";

export interface GroupCoordinatorPort {
  installations(): Iterable<InstallationRecord>;
  createDraft(
    group: GroupNode,
    plugin: ErasedPlugin,
    config: unknown,
  ): { readonly record: InstallationRecord; readonly publicInstallation: object };
  resolveInstallation(installation: object): InstallationRecord;
  executeChanges(group: GroupNode, operations: ReadonlyArray<ChangeOperation>): Promise<void>;
  attachInstallation(installation: InstallationRecord): void;
  discardInstallation(installation: InstallationRecord, error: unknown): void;
  runExclusive(operation: () => Promise<void>): Promise<void>;
  removeInstallations(operations: ReadonlyArray<ChangeOperation>): Promise<void>;
  notifyChanged(): void;
}

interface GroupControl {
  finishConfiguration(): void;
  revoke(): void;
}

const groupControls = new WeakMap<object, GroupControl>();

type GroupState =
  | {
      readonly phase: "configuring";
      readonly coordinator: GroupCoordinator;
      readonly configuration: GroupConfigurationSession<ChangeSetDraft>;
    }
  | { readonly phase: "attached"; readonly coordinator: GroupCoordinator }
  | { readonly phase: "revoked" };

class GroupImpl implements Group {
  readonly #node: GroupNode;
  #state: GroupState;

  constructor(
    coordinator: GroupCoordinator,
    node: GroupNode,
    configuration?: GroupConfigurationSession<ChangeSetDraft>,
  ) {
    this.#node = node;
    this.#state = configuration
      ? { phase: "configuring", coordinator, configuration }
      : { phase: "attached", coordinator };
    groupControls.set(this, {
      finishConfiguration: () => {
        const state = this.#state;
        if (state.phase === "configuring") {
          this.#state = { phase: "attached", coordinator: state.coordinator };
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
    return state.phase === "revoked" ? "removed" : state.coordinator.status(this.#node);
  }

  ready() {
    const state = this.#state;
    return state.phase === "revoked"
      ? Promise.reject(groupRemovedError(this.#node))
      : state.coordinator.ready(this.#node);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ) {
    const state = this.#state;
    if (state.phase === "configuring") {
      return state.configuration.requireDraft().install(plugin, ...config);
    }
    return this.#requireCoordinator().install(this.#node, plugin, ...config);
  }

  change() {
    if (this.#state.phase === "configuring") {
      throw new TypeError("Cannot create a ChangeSet while a Group is being configured");
    }
    return this.#requireCoordinator().change(this.#node);
  }

  group(name: string, configure: (group: Group) => void) {
    const state = this.#state;
    if (state.phase === "configuring") state.configuration.assertOpen();
    return this.#requireCoordinator().create(
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
    return state.phase === "attached" ? state.coordinator.remove(this.#node) : Promise.resolve();
  }

  #requireCoordinator() {
    const state = this.#state;
    if (state.phase === "revoked") throw groupRemovedError(this.#node);
    return state.coordinator;
  }
}

/** Owns the complete structural Group model and compiles it to Installation changes. */
export class GroupCoordinator {
  readonly root: GroupNode;
  readonly #port: GroupCoordinatorPort;
  readonly #publicGroups = new WeakMap<GroupNode, GroupImpl>();
  readonly #lifecycles = new WeakMap<GroupNode, GroupLifecycle>();

  constructor(rootName: string, port: GroupCoordinatorPort) {
    this.root = GroupNode.root(rootName);
    this.#port = port;
    this.#lifecycles.set(
      this.root,
      new GroupLifecycle(this.root, "established", () => port.notifyChanged()),
    );
  }

  nodes() {
    return this.root.walk();
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    group: GroupNode,
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput> {
    const changes = this.change(group);
    const installation = changes.install(plugin, ...config);
    observeReadinessOperation(changes.commit());
    return installation;
  }

  change(group: GroupNode, tracking: "immediate" | "deferred" = "immediate") {
    this.#requireLifecycle(group);
    return new ChangeSetDraft({
      create: (plugin, config) => {
        this.#requireLifecycle(group);
        return this.#port.createDraft(group, plugin, config);
      },
      resolve: (value) => {
        this.#requireLifecycle(group);
        const installation = this.#port.resolveInstallation(value);
        if (!installation.attached) throw installation.unavailableError();
        if (!group.contains(installation.group)) {
          throw new TypeError(`Installation '${installation.id}' is outside Group '${group.id}'`);
        }
        return installation;
      },
      execute: (operations) => {
        this.#requireLifecycle(group);
        const operation = this.#port.executeChanges(group, operations);
        for (const change of operations) change.installation.trackReadiness(operation);
        if (operations.length && tracking === "immediate") this.#track(group, operation);
        return operation;
      },
      attach: (installation) => {
        this.#requireLifecycle(group);
        this.#port.attachInstallation(installation);
      },
      discard: (installation, error) => this.#port.discardInstallation(installation, error),
    });
  }

  create(
    parent: GroupNode,
    name: string,
    configure: (group: Group) => void,
    inherited?: GroupConfigurationSession<ChangeSetDraft>,
  ) {
    if (typeof configure !== "function") throw new TypeError("Group configure must be a function");
    const node = parent.create(name);
    this.#lifecycles.set(node, new GroupLifecycle(node, "new", () => this.#port.notifyChanged()));
    const ownsConfiguration = inherited === undefined;
    const configuration =
      inherited ??
      new GroupConfigurationSession(this.change(node, "deferred"), discardChangeSetDraft, (error) =>
        normalizeFailure(
          error,
          "GROUP_UNAVAILABLE",
          `Group '${node.id}' configuration failed with a non-Error value`,
        ),
      );
    const group = new GroupImpl(this, node, configuration);
    this.#publicGroups.set(node, group);

    try {
      const result: unknown = configure(group);
      if (isThenable(result)) {
        rejectAsyncConfiguration(result);
      }
      const failure = configuration.failure;
      if (failure) throw failure;
    } catch (error) {
      const failure = configuration.fail(error);
      const removedGroups = node.walk();
      node.detach();
      this.#revoke(removedGroups);
      if (ownsConfiguration) configuration.discard(failure);
      this.#port.notifyChanged();
      throw failure;
    }

    if (ownsConfiguration) {
      const operation = configuration.seal().commit();
      for (const child of node.walk()) {
        const childGroup = this.#publicGroups.get(child);
        if (childGroup) groupControls.get(childGroup)?.finishConfiguration();
        this.#track(child, operation);
      }
      observeReadinessOperation(operation);
    }
    this.#port.notifyChanged();
    return group;
  }

  async ready(group: GroupNode) {
    await this.#requireLifecycle(group).ready(async () => {
      await Promise.all(this.#installationsIn(group).map((installation) => installation.ready()));
    });
  }

  status(group: GroupNode): LifecycleStatus {
    if (!group.attached) return "removed";
    return this.#requireLifecycle(group).status(this.#contentsStatus(group));
  }

  remove(group: GroupNode) {
    if (group === this.root) throw new TypeError("The root Group cannot be removed");
    if (!group.attached) {
      this.#revoke([group]);
      return Promise.resolve();
    }
    return this.#port.runExclusive(async () => {
      if (!group.attached) {
        this.#revoke([group]);
        return;
      }
      const removedGroups = group.walk();
      const operations = this.#installationsIn(group).map((installation): ChangeOperation => ({
        kind: "remove",
        installation,
      }));
      await this.#port.removeInstallations(operations);
      group.detach();
      this.#revoke(removedGroups);
      this.#port.notifyChanged();
    });
  }

  #installationsIn(group: GroupNode) {
    return [...this.#port.installations()].filter((installation) =>
      group.contains(installation.group),
    );
  }

  #contentsStatus(group: GroupNode): LifecycleStatus {
    const installations = this.#installationsIn(group);
    if (installations.some((installation) => installation.status === "failed")) return "failed";
    if (installations.some((installation) => installation.status === "stopping")) {
      return "stopping";
    }
    if (
      installations.length &&
      installations.every((installation) => installation.status === "active")
    ) {
      return "active";
    }
    return installations.length ? "pending" : "active";
  }

  #track(group: GroupNode, operation: Promise<void>) {
    this.#requireLifecycle(group).track(operation);
  }

  #requireLifecycle(group: GroupNode) {
    const lifecycle = this.#lifecycles.get(group);
    if (!group.attached || !lifecycle) throw groupRemovedError(group);
    return lifecycle;
  }

  #revoke(groups: Iterable<GroupNode>) {
    for (const group of groups) {
      this.#lifecycles.get(group)?.release();
      this.#lifecycles.delete(group);
      const publicGroup = this.#publicGroups.get(group);
      if (publicGroup) {
        groupControls.get(publicGroup)?.revoke();
        groupControls.delete(publicGroup);
      }
      this.#publicGroups.delete(group);
    }
  }
}

/** Failures remain observable through ready(); this only marks the owned branch handled. */
function observeReadinessOperation(operation: PromiseLike<unknown>) {
  void Promise.resolve(operation).catch(() => undefined);
}

function rejectAsyncConfiguration(result: PromiseLike<unknown>): never {
  // The synchronous TypeError is the configuration result. The rejected async
  // branch is outside the accepted contract and must not become an unhandled rejection.
  void Promise.resolve(result).catch(() => undefined);
  throw new TypeError("Group configure must be synchronous");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}
