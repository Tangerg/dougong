import type { Group, Installation, PluginConfigArguments } from "./host-api";
import {
  discardChangeSetDraft,
  stageChangeSetInstallation,
  ChangeSetDraft,
  type ChangeOperation,
} from "./change-set";
import { normalizeFailure } from "./errors";
import { GroupNode } from "./group";
import { GroupConfigurationSession } from "./group-configuration";
import { groupRemovedError, GroupLifecycle } from "./group-lifecycle";
import type { InstallationRecord } from "./installation";
import type { LifecycleStatus } from "./lifecycle-status";
import type { AnyPlugin, NormalizedPlugin } from "./plugin";
import { assertSynchronous } from "./sync-result";

export interface GroupCoordinatorPort {
  readonly installations: () => Iterable<InstallationRecord>;
  readonly createDraft: (
    group: GroupNode,
    plugin: NormalizedPlugin,
    config: unknown,
  ) => { readonly record: InstallationRecord; readonly facade: Installation<AnyPlugin> };
  readonly resolveInstallation: (installation: object) => InstallationRecord;
  readonly executeChanges: (
    group: GroupNode,
    operations: ReadonlyArray<ChangeOperation>,
  ) => Promise<void>;
  readonly attachInstallation: (installation: InstallationRecord) => void;
  readonly discardInstallation: (installation: InstallationRecord, error: unknown) => void;
  readonly runExclusive: (operation: () => Promise<void>) => Promise<void>;
  readonly removeInstallations: (operations: ReadonlyArray<ChangeOperation>) => Promise<void>;
  readonly notifyChanged: () => void;
}

interface GroupControl {
  readonly finishConfiguration: () => void;
  readonly revoke: () => void;
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

class GroupFacade implements Group {
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

  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ) {
    const state = this.#state;
    if (state.phase === "configuring") {
      return state.coordinator.stageConfigurationInstall(
        this.#node,
        state.configuration,
        plugin,
        ...config,
      );
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

/**
 * Owns the complete structural Group model and compiles it to Installation
 * changes.
 *
 * Groups are structure, and the Engine only understands installations, so
 * everything here ends as a `ChangeOperation` list. Removing a Group is not its
 * own kind of command — it is the removal of every Installation the subtree
 * contains, followed by detaching the nodes.
 *
 * Lifecycles and facades are held in WeakMaps keyed by node rather than as node
 * fields, so `GroupNode` stays pure structure and a revoked facade releases both.
 */
export class GroupCoordinator {
  readonly root: GroupNode;
  readonly #port: GroupCoordinatorPort;
  readonly #facades = new WeakMap<GroupNode, GroupFacade>();
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

  install<Declaration extends AnyPlugin>(
    group: GroupNode,
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration> {
    const changes = this.change(group);
    const installation = changes.install(plugin, ...config);
    observeReadinessOperation(changes.commit());
    return installation;
  }

  stageConfigurationInstall<Declaration extends AnyPlugin>(
    group: GroupNode,
    configuration: GroupConfigurationSession<ChangeSetDraft>,
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration> {
    this.#requireLifecycle(group);
    return stageChangeSetInstallation(
      configuration.requireDraft(),
      plugin,
      config[0],
      (normalized, value) => {
        this.#requireLifecycle(group);
        return this.#port.createDraft(group, normalized, value);
      },
    );
  }

  /**
   * `deferred` tracking exists for `create()`. A Group being configured must not
   * mark itself pending on each nested install, because the whole configuration
   * commits once; the coordinator attaches that single operation to every node in
   * the finished subtree instead.
   */
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
        if (!installation.hasAuthority) throw installation.unavailableError();
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
    const facade = new GroupFacade(this, node, configuration);
    this.#facades.set(node, facade);

    try {
      // Synchronous by contract. An async callback would return before its
      // installs were staged, so the session would seal an incomplete subtree
      // and the awaited work would then stage into a sealed draft.
      const result: unknown = configure(facade);
      assertSynchronous(result, "Group configure must be synchronous");
      // A nested `group()` that failed recorded its error on the shared session
      // without throwing here. Checking the session is what makes a failure deep
      // in the tree collapse the whole `create()`.
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
        const childFacade = this.#facades.get(child);
        if (childFacade) groupControls.get(childFacade)?.finishConfiguration();
        this.#requireLifecycle(child).track(operation);
      }
      this.#track(parent, operation);
      observeReadinessOperation(operation);
    }
    this.#port.notifyChanged();
    return facade;
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
    const operation = this.#port.runExclusive(async () => {
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
    this.#track(group, operation);
    return operation;
  }

  #installationsIn(group: GroupNode) {
    return [...this.#port.installations()].filter((installation) =>
      group.contains(installation.group),
    );
  }

  // A Group has no status of its own — it reports what its contents say, with
  // the worst news winning. The last line is the one that needs stating: an
  // empty Group is `active`, because a subtree that owns nothing has nothing
  // left to wait for.
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
    for (let node: GroupNode | undefined = group; node; node = node.parent) {
      this.#requireLifecycle(node).track(operation);
    }
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
      const facade = this.#facades.get(group);
      if (facade) {
        groupControls.get(facade)?.revoke();
        groupControls.delete(facade);
      }
      this.#facades.delete(group);
    }
  }
}

/** Failures remain observable through ready(); this only marks the owned branch handled. */
function observeReadinessOperation(operation: PromiseLike<unknown>) {
  void Promise.resolve(operation).catch(() => undefined);
}
