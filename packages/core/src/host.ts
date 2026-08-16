import type { Host, HostOptions, ChangeSet, Group } from "./host-api";
import { Engine, type TransitionOutcome } from "./engine";
import type { ChangeOperation } from "./change-set";
import type { Service } from "./contracts";
import { HostDiagnostics, type HostSnapshot, type HostStatus } from "./diagnostics";
import { GroupCoordinator } from "./group-coordinator";
import type { GroupNode } from "./group";
import { groupRemovedError } from "./group-lifecycle";
import { InstallationRegistry } from "./installation-registry";
import { isLogger, type Logger } from "./lifetime";
import type { Plugin, Provisions, Requirements } from "./plugin";
import { SerialQueue } from "./serial-queue";
import type { SnapshotView } from "./snapshot-view";
import { assertPlainRecord } from "./record";

export type { InstallationStatus } from "./installation";
export type { GroupStatus } from "./group";
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

const defaultLogger: Logger = console;
const hostOptionFields = new Set(["name", "logger", "onError"]);

class HostImpl implements Host {
  readonly name: string;
  readonly diagnostics: SnapshotView<HostSnapshot>;

  readonly #installations: InstallationRegistry;
  readonly #diagnosticModel: HostDiagnostics;
  readonly #logger: Logger;
  readonly #groups: GroupCoordinator;
  readonly #onError: (error: unknown) => void;
  readonly #engine: Engine;

  #status: HostStatus = "idle";
  readonly #commands = new SerialQueue();

  constructor(options: HostOptions = {}) {
    assertPlainRecord(options, "Host options", { fields: hostOptionFields });
    const configuredName = Object.hasOwn(options, "name") ? options.name : undefined;
    const configuredLogger = Object.hasOwn(options, "logger") ? options.logger : undefined;
    const configuredOnError = Object.hasOwn(options, "onError") ? options.onError : undefined;
    const name = configuredName ?? "host";
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Host name must be a non-empty string");
    }
    if (name !== name.trim()) {
      throw new TypeError("Host name cannot start or end with whitespace");
    }
    if (configuredOnError !== undefined && typeof configuredOnError !== "function") {
      throw new TypeError("Host onError must be a function");
    }
    if (configuredLogger !== undefined && !isLogger(configuredLogger)) {
      throw new TypeError("Host logger must implement debug/info/warn/error");
    }

    this.name = name;
    this.#logger = configuredLogger ?? defaultLogger;
    this.#onError = configuredOnError ?? ((error) => this.#logger.error(error));
    this.#installations = new InstallationRegistry({
      notifyChanged: () => this.#publishDiagnostics(),
      update: (installation, facade, update) =>
        this.#groups.change(installation.group).update(facade, update).commit(),
      remove: (installation, facade) =>
        this.#groups.change(installation.group).remove(facade).commit(),
    });
    this.#engine = new Engine({
      hostName: name,
      logger: this.#logger,
      isInstalled: (installationId) => this.#installations.has(installationId),
      report: (error) => this.#report(error),
    });
    this.#groups = new GroupCoordinator(name, {
      installations: () => this.#installations.values(),
      createDraft: (group, plugin, config) => this.#installations.create(group, plugin, config),
      resolveInstallation: (installation) => this.#installations.resolve(installation),
      executeChanges: (group, operations) => this.#executeChanges(group, operations),
      attachInstallation: (installation) => this.#installations.attach(installation),
      discardInstallation: (installation, error) =>
        this.#installations.discard(installation, error),
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
    return this.#engine.get(token, availability);
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
        const plan = this.#engine.buildPlan(this.#installations.values());
        await this.#engine.start(plan);
        this.#setStatus("active");
        this.#installations.settleReadiness(plan.order);
      } catch (error) {
        this.#setStatus("idle");
        for (const installation of this.#installations.values()) {
          if (installation.status !== "active") installation.fail(error);
        }
        this.#installations.settleReadiness(this.#installations.values());
        throw error;
      }
    });
  }

  stop() {
    return this.#commands.run(async () => {
      if (this.#status === "idle") return;
      this.#setStatus("stopping");
      const errors = await this.#engine.stop();
      this.#setStatus("idle");
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Host shutdown failed");
    });
  }

  #executeChanges(group: GroupNode, operations: ReadonlyArray<ChangeOperation>) {
    const installed = operations
      .filter((operation): operation is Extract<ChangeOperation, { kind: "install" }> => {
        return operation.kind === "install";
      })
      .map((operation) => operation.installation);

    return this.#commands.run(async () => {
      try {
        if (!group.attached) throw groupRemovedError(group);
        if (!operations.length) return;
        if (this.#status === "active") {
          await this.#transact(operations);
        } else {
          this.#installations.apply(operations);
          this.#installations.settleChanges(operations, false);
        }
        this.#publishDiagnostics();
      } catch (error) {
        for (const installation of installed) {
          if (!this.#installations.contains(installation)) {
            this.#installations.discard(installation, error);
          }
        }
        throw error;
      }
    });
  }

  async #removeInstallations(operations: ReadonlyArray<ChangeOperation>) {
    if (operations.length && this.#status === "active") {
      await this.#transact(operations);
    } else {
      this.#installations.apply(operations);
      this.#installations.settleChanges(operations, false);
    }
  }

  async #transact(operations: ReadonlyArray<ChangeOperation>) {
    const outcome = await this.#runTransaction(operations);
    this.#installations.settleReadiness(outcome.affected);
    if (outcome.kind === "rolled-back") throw outcome.error;
    this.#installations.settleChanges(operations, true);
  }

  async #runTransaction(operations: ReadonlyArray<ChangeOperation>): Promise<TransitionOutcome> {
    const snapshot = this.#installations.capture();
    const changed = new Set(operations.map((operation) => operation.installation));
    this.#setStatus("changing");

    let nextPlan;
    try {
      this.#installations.apply(operations);
      nextPlan = this.#engine.buildPlan(this.#installations.values());
    } catch (error) {
      this.#installations.restore(snapshot);
      this.#setStatus("active");
      throw error;
    }

    try {
      const outcome = await this.#engine.transition(nextPlan, changed, () =>
        this.#installations.restore(snapshot),
      );
      this.#setStatus("active");
      return outcome;
    } catch (error) {
      this.#setStatus(this.#engine.hasCommittedPlan ? "active" : "idle");
      throw error;
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
        // Error observation must never mutate the Host command being observed.
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

export function createHost(options?: HostOptions): Host {
  return new HostImpl(options);
}
