import type { Host, HostOptions, ChangeSet, Group, PluginConfigArguments } from "./host-api";
import { Engine, type TransitionOutcome } from "./engine";
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
import { assertPlainRecord } from "./record";

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

/**
 * The Host owns no domain state. It is a serialization boundary over three
 * peers, each of which is the single source of truth for one thing:
 *
 *   InstallationRegistry  declarations and public-handle authority
 *   GroupCoordinator      installation ownership structure
 *   Engine                the committed plan, and commit/rollback/fail-closed
 *
 * What the Host adds is the `SerialQueue`, the `HostStatus` transitions, and the
 * decision of which path a change takes — direct application while idle, a full
 * transaction while active. Any state kept here as well would be a second state
 * machine to keep in agreement with one of the three; `check-layers.mjs` has an
 * inverted rule that fails if one appears.
 */
class HostImpl implements Host {
  readonly name: string;
  readonly diagnostics: SnapshotView<HostSnapshot>;

  readonly #installations: InstallationRegistry;
  readonly #diagnosticModel: HostDiagnostics;
  readonly #logger: Logger;
  readonly #groups: GroupCoordinator;
  readonly #onError: NonNullable<HostOptions["onError"]>;
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
    this.#diagnosticModel = new HostDiagnostics(
      name,
      () => ({
        status: this.#status,
        installations: this.#installations.values(),
        groups: this.#groups.nodes(),
      }),
      (error) => this.#report(error),
    );
    this.diagnostics = this.#diagnosticModel.view;
    Object.freeze(this);
  }

  get status() {
    return this.#status;
  }

  get<T>(token: Service<T>): T;
  get<T>(token: OptionalService<T>): T | undefined;
  get<T>(token: Service<T> | OptionalService<T>): T | undefined {
    // Only `active` opens the read window. During `starting`, `changing` and
    // `stopping` a plan exists but is not the committed one, so answering would
    // expose an intermediate graph — the Engine raises SERVICE_UNAVAILABLE
    // instead. An `optional()` token does not soften this: the difference
    // between "not installed" and "not readable yet" has to stay visible.
    const availability = this.#status === "active" ? "available" : "unavailable";
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
      if (this.#status === "active") return;
      this.#setStatus("starting");
      try {
        const plan = this.#engine.buildPlan(this.#installations.values());
        await this.#engine.start(plan);
        this.#setStatus("active");
        this.#installations.settleReadiness(plan.order);
      } catch (error) {
        // Back to `idle`, not to a `failed` Host: the Engine has already
        // disposed whatever it activated, so there is no partial graph left to
        // describe and `start()` may be attempted again. Every Installation
        // still needs its readiness settled, or a caller already awaiting
        // `ready()` would wait for an attempt that no longer exists.
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
        // While idle there are no Instances to stop or start, so the change is
        // just a declaration edit. A transaction is only needed once a committed
        // plan exists that the change could break.
        if (this.#status === "active") {
          await this.#transact(operations);
        } else {
          this.#installations.apply(operations);
          this.#installations.settleChanges(operations, false);
        }
        this.#publishDiagnostics();
      } catch (error) {
        // An install that never reached the registry leaves a handle the caller
        // already holds. Discarding it makes that handle report the real failure
        // rather than behave like an Installation that is merely not ready yet.
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

  // Three failure levels, in the order they are attempted:
  //
  //   1. the new plan does not even build       restore declarations, stay active
  //   2. the plan builds but activation fails   Engine rolls back to the previous
  //                                             Instances and reports the cause
  //   3. rollback itself cannot complete        fail closed: everything stops and
  //                                             the Host reports `idle`
  //
  // Level 3 is the one worth stating out loud. A Host that cannot restore its
  // previous state is not healthy, so it refuses to present itself as active —
  // `hasCommittedPlan` is what distinguishes the two outcomes here.
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

  #setStatus(status: HostStatus) {
    this.#status = status;
    this.#publishDiagnostics();
  }

  #publishDiagnostics() {
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
    // The logger is the terminal error sink. Its own asynchronous failure has
    // no lower reporting channel, but it must still be observed.
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Error observation must never mutate the Host command being observed.
  }
}
