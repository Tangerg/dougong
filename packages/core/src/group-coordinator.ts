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
  readonly settled: () => Promise<void>;
  readonly removeInstallations: (operations: ReadonlyArray<ChangeOperation>) => Promise<void>;
  readonly notifyChanged: () => void;
}

interface GroupControl {
  readonly revoke: () => void;
}

const groupControls = new WeakMap<object, GroupControl>();

interface GroupBinding {
  readonly coordinator: GroupCoordinator;
  readonly configuration: GroupConfigurationSession<ChangeSetDraft> | undefined;
}

class GroupFacade implements Group {
  readonly #node: GroupNode;
  #binding: GroupBinding | undefined;

  constructor(
    coordinator: GroupCoordinator,
    node: GroupNode,
    configuration?: GroupConfigurationSession<ChangeSetDraft>,
  ) {
    this.#node = node;
    this.#binding = { coordinator, configuration };
    groupControls.set(this, {
      revoke: () => {
        this.#binding = undefined;
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
    return this.#node.attached ? this.#requireBinding().coordinator.status(this.#node) : "removed";
  }

  ready() {
    return this.#node.attached
      ? this.#requireBinding().coordinator.ready(this.#node)
      : Promise.reject(groupRemovedError(this.#node));
  }

  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ) {
    const { coordinator } = this.#requireBinding();
    const configuration = this.#configuration();
    if (configuration) {
      return coordinator.stageConfigurationInstall(this.#node, configuration, plugin, ...config);
    }
    return coordinator.install(this.#node, plugin, ...config);
  }

  change() {
    const configuration = this.#configuration();
    if (configuration) {
      throw configuration.fail(
        new TypeError("Cannot create a ChangeSet while a Group is being configured"),
      );
    }
    return this.#requireBinding().coordinator.change(this.#node);
  }

  group(name: string, configure: (group: Group) => void) {
    const { coordinator } = this.#requireBinding();
    const configuration = this.#configuration();
    return configuration
      ? configuration.run(() => coordinator.create(this.#node, name, configure, configuration))
      : coordinator.create(this.#node, name, configure);
  }

  remove() {
    if (!this.#node.attached) return Promise.resolve();
    const configuration = this.#configuration();
    if (configuration) {
      throw configuration.fail(new TypeError("Cannot remove a Group while it is being configured"));
    }
    return this.#requireBinding().coordinator.remove(this.#node);
  }

  #configuration() {
    const configuration = this.#requireBinding().configuration;
    return configuration?.sealed ? undefined : configuration;
  }

  #requireBinding() {
    if (!this.#node.attached || !this.#binding) throw groupRemovedError(this.#node);
    return this.#binding;
  }
}

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
    return configuration.run((draft) =>
      stageChangeSetInstallation(draft, plugin, config[0], (normalized, value) => {
        this.#requireLifecycle(group);
        return this.#port.createDraft(group, normalized, value);
      }),
    );
  }

  // Configuration commits once, so nested installs must not create independent readiness barriers.
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
        if (operations.length && tracking === "immediate") {
          this.#track([group, ...operations.map((change) => change.installation.group)], operation);
        }
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
      configuration.run(() => {
        // An async configure callback would seal the draft before its awaited installs were staged.
        const result: unknown = configure(facade);
        assertSynchronous(result, "Group configure must be synchronous");
      });
    } catch (error) {
      this.#revoke(node.detach());
      if (ownsConfiguration) configuration.discard(error);
      this.#port.notifyChanged();
      throw error;
    }

    if (ownsConfiguration) {
      const operation = configuration.seal().commit();
      this.#track(node.walk(), operation);
      observeReadinessOperation(operation);
    }
    this.#port.notifyChanged();
    return facade;
  }

  async ready(group: GroupNode) {
    await this.#port.settled();
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
      const operations = this.#installationsIn(group).map((installation): ChangeOperation => ({
        kind: "remove",
        installation,
      }));
      await this.#port.removeInstallations(operations);
      this.#revoke(group.detach());
      this.#port.notifyChanged();
    });
    this.#track(group.walk(), operation);
    return operation;
  }

  #installationsIn(group: GroupNode) {
    return [...this.#port.installations()].filter((installation) =>
      group.contains(installation.group),
    );
  }

  // An empty Group is active because it owns nothing that could remain unready.
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

  #track(groups: Iterable<GroupNode>, operation: Promise<void>) {
    const ancestors = new Set<GroupNode>();
    for (const group of groups) {
      for (let node: GroupNode | undefined = group; node; node = node.parent) ancestors.add(node);
    }
    for (const group of ancestors) this.#requireLifecycle(group).track(operation);
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

// ready() retains the failure; this branch only prevents an unhandled rejection.
function observeReadinessOperation(operation: PromiseLike<unknown>) {
  void Promise.resolve(operation).catch(() => undefined);
}
