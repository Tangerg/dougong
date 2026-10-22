import type { Host, HostOptions, ChangeSet, Group, PluginConfigArguments } from "./host-api";
import { Engine } from "./engine";
import type { ChangeOperation } from "./change-set";
import type { ExtensionPoint, OptionalService, Service } from "./contracts";
import { HostDiagnostics, type HostSnapshot, type HostStatus } from "./diagnostics";
import { GroupCoordinator } from "./group-coordinator";
import type { GroupNode } from "./group";
import { groupRemovedError } from "./group-lifecycle";
import { InstallationRegistry } from "./installation-registry";
import { isLogger, type Logger } from "./lifetime";
import type { AnyPlugin } from "./plugin";
import { SerialQueue } from "./serial-queue";
import type { SnapshotView } from "./snapshot-view";
import { normalizePlainRecord } from "./record";

export type { LifecycleStatus } from "./lifecycle-status";
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
type HostCommandPhase = Exclude<HostStatus, "active" | "idle">;

class HostImpl implements Host {
  readonly name: string;
  readonly diagnostics: SnapshotView<HostSnapshot>;

  readonly #installations: InstallationRegistry;
  readonly #diagnosticModel: HostDiagnostics;
  readonly #logger: Logger;
  readonly #groups: GroupCoordinator;
  readonly #onError: NonNullable<HostOptions["onError"]>;
  readonly #engine: Engine;

  #commandPhase: HostCommandPhase | undefined;
  readonly #commands = new SerialQueue();

  constructor(options: HostOptions = {}) {
    const declaration = normalizePlainRecord(options, "Host options", { fields: hostOptionFields });
    const configuredName = declaration.name;
    const configuredLogger = declaration.logger;
    const configuredOnError = declaration.onError;
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
      settled: () => this.#commands.settled,
      report: (error) => this.#report(error),
      notifyChanged: () => this.#diagnosticModel.publish(),
      update: (installation, facade, update) => {
        const change = this.#groups.change(installation.group);
        change.update(facade, update);
        return change.commit();
      },
      remove: (installation, facade) => {
        const change = this.#groups.change(installation.group);
        change.remove(facade);
        return change.commit();
      },
    });
    this.#engine = new Engine({
      hostName: name,
      logger: this.#logger,
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
      settled: () => this.#commands.settled,
      removeInstallations: (operations) => this.#removeInstallations(operations),
      notifyChanged: () => this.#diagnosticModel.publish(),
    });
    this.#diagnosticModel = new HostDiagnostics(
      name,
      () => ({
        status: this.status,
        installations: this.#installations.values(),
        groups: this.#groups.nodes(),
      }),
      (error) => this.#report(error),
    );
    this.diagnostics = this.#diagnosticModel.view;
    Object.freeze(this);
  }

  get status(): HostStatus {
    return this.#commandPhase ?? (this.#engine.hasCommittedPlan ? "active" : "idle");
  }

  get<T>(token: Service<T>): T;
  get<T>(token: OptionalService<T>): T | undefined;
  get<T>(token: Service<T> | OptionalService<T>): T | undefined {
    // Reads require active status because starting, changing and stopping may hold intermediate plans.
    const availability = this.status === "active" ? "available" : "unavailable";
    return this.#engine.get(token, availability);
  }

  contributions<T>(token: ExtensionPoint<T>) {
    return this.#engine.contributions(token);
  }

  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
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
      if (this.status === "active") return;
      this.#setCommandPhase("starting");
      try {
        const plan = this.#engine.buildPlan(this.#installations.declarations());
        await this.#engine.start(plan);
        this.#installations.settleReadiness(plan.order);
      } catch (error) {
        // Settle every Installation readiness after failed startup so existing waiters cannot outlive the attempt.
        for (const installation of this.#installations.values()) {
          if (installation.status !== "active") installation.fail(error);
        }
        this.#installations.settleReadiness(this.#installations.values());
        throw error;
      } finally {
        this.#setCommandPhase(undefined);
      }
    });
  }

  stop() {
    return this.#commands.run(async () => {
      if (this.status === "idle") return;
      this.#setCommandPhase("stopping");
      try {
        const errors = await this.#engine.stop();
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Host shutdown failed");
      } finally {
        this.#setCommandPhase(undefined);
      }
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
        const pending = this.#installations.pendingOperations(operations);
        if (operations.length && !pending.length) return;
        if (!group.attached) throw groupRemovedError(group);
        if (!pending.length) return;
        // Idle changes only edit declarations because there are no live Instances to transact against.
        if (this.status === "active") {
          await this.#transact(pending);
        } else {
          this.#installations.commit(this.#installations.draft(pending), pending, false);
          this.#installations.settleReadiness(pending.map((operation) => operation.installation));
        }
        this.#diagnosticModel.publish();
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
    if (operations.length && this.status === "active") {
      await this.#transact(operations);
    } else {
      this.#installations.commit(this.#installations.draft(operations), operations, false);
      this.#installations.settleReadiness(operations.map((operation) => operation.installation));
    }
  }

  async #transact(operations: ReadonlyArray<ChangeOperation>) {
    const changed = new Set(operations.map((operation) => operation.installation));
    this.#setCommandPhase("changing");
    try {
      const draft = this.#installations.draft(operations);
      const nextPlan = this.#engine.buildPlan(draft);
      const outcome = await this.#engine.transition(nextPlan, changed, () => {
        this.#installations.commit(draft, operations, true);
      });
      if (outcome.kind === "failed-closed") {
        for (const installation of outcome.affected) installation.fail(outcome.error);
      }
      this.#installations.settleReadiness(outcome.affected);
      if (outcome.kind !== "committed") throw outcome.error;
    } finally {
      this.#setCommandPhase(undefined);
    }
  }

  #report(error: unknown) {
    const logger = this.#logger;
    try {
      const result: unknown = this.#onError(error);
      void Promise.resolve(result).catch((reporterError) => {
        reportToFallbackLogger(logger, error, reporterError);
      });
    } catch (reporterError) {
      reportToFallbackLogger(logger, error, reporterError);
    }
  }

  #setCommandPhase(phase: HostCommandPhase | undefined) {
    this.#commandPhase = phase;
    this.#diagnosticModel.publish();
  }
}

export function createHost(options?: HostOptions): Host {
  return new HostImpl(options);
}

function reportToFallbackLogger(logger: Logger, error: unknown, reporterError: unknown) {
  try {
    const result: unknown = logger.error(
      new AggregateError([error, reporterError], "Host error reporter failed"),
    );
    // The terminal logger has no lower error sink, but its rejection still needs observation.
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Error observation must not mutate the command being observed.
  }
}
