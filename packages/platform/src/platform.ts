import {
  asyncDisposeSymbol,
  normalizePlainRecord,
  type AnyPlugin,
  type Logger,
  type Installer,
  isLogger,
  isError,
  SerialQueue,
  type SnapshotView,
} from "@dougongjs/core";
import { isConcreteVersion } from "./manifest";
import { Activator, type ActivationBarrier } from "./activator";
import { loadPlugin, normalizeArtifact } from "./artifact";
import { validateCandidateGraph } from "./candidate-graph";
import { stageCoreChange } from "./core-change";
import { PlatformDiagnostics, type PlatformSnapshot } from "./diagnostics";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import {
  assertCurrentRegistration,
  normalizeRegistrationFailure,
  RegistrationRecord,
  type RegistrationPort,
} from "./registration";
import {
  PlatformChangeSetDraft,
  type PlatformChangeOperation,
  type PlatformChangePort,
} from "./platform-change-set";
import type {
  PlatformOptions,
  Registration,
  NormalizedArtifact,
  PlatformChangeSet,
  Artifact,
  Platform,
} from "./platform-api";
import { PermissionSet, type Authorizer } from "./permissions";

const platformOptionFields = new Set(["installer", "apiVersion", "loader", "authorizer", "logger"]);

interface PlatformAuthority<Reference> {
  current: PlatformImpl<Reference> | undefined;
}

interface PlatformPorts<Reference> {
  readonly installer: Pick<Installer, "change">;
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
  readonly logger: Logger;
}

interface PlatformChangePlan<Reference> {
  readonly targets: ReadonlyArray<RegistrationRecord<Reference>>;
  readonly installedUpdates: ReadonlySet<RegistrationRecord<Reference>>;
}

type PlatformState<Reference> =
  | { readonly phase: "active"; readonly ports: PlatformPorts<Reference> }
  | {
      readonly phase: "disposing";
      readonly ports: PlatformPorts<Reference>;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed" };

// Revocable authority cells let retained Registration callbacks detach from a disposed Platform.
class PlatformImpl<Reference> implements Platform<Reference> {
  readonly #registrations = new Map<string, RegistrationRecord<Reference>>();
  readonly #ownedRegistrations = new WeakMap<object, RegistrationRecord<Reference>>();
  readonly #diagnosticModel: PlatformDiagnostics;
  readonly #registrationPort: RegistrationPort<Reference>;
  readonly #changePort: PlatformChangePort<Reference>;
  readonly #authority: PlatformAuthority<Reference>;
  readonly #changeQueue = new SerialQueue();
  readonly #activator: Activator<Reference>;
  #state: PlatformState<Reference>;
  #changeController: AbortController | undefined;

  readonly apiVersion: string;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;

  constructor(options: PlatformOptions<Reference>) {
    const declaration = normalizePlainRecord(options, "Platform options", {
      fields: platformOptionFields,
    });
    const { installer, apiVersion, loader, authorizer, logger } = declaration;
    if (typeof apiVersion !== "string" || !isConcreteVersion(apiVersion)) {
      throw new TypeError("Platform apiVersion must be a semantic version");
    }
    if (!installer || typeof installer.change !== "function") {
      throw new TypeError("Platform installer must implement change()");
    }
    if (!loader || typeof loader.load !== "function") {
      throw new TypeError("Platform loader must implement load()");
    }
    if (authorizer !== undefined && (!authorizer || typeof authorizer.authorize !== "function")) {
      throw new TypeError("Platform authorizer must implement authorize()");
    }
    if (logger !== undefined && !isLogger(logger)) {
      throw new TypeError("Platform logger must implement debug/info/warn/error");
    }
    const authority: PlatformAuthority<Reference> = { current: this };
    this.#authority = authority;
    this.apiVersion = apiVersion;
    this.#state = {
      phase: "active",
      ports: Object.freeze({
        installer,
        loader,
        authorizer: authorizer ?? new PermissionSet(),
        logger: logger ?? console,
      }),
    };
    this.#diagnosticModel = new PlatformDiagnostics(
      this.apiVersion,
      () => ({
        status: this.#state.phase,
        registrations: this.#registrations.values(),
      }),
      createDiagnosticReporter(this.#requirePorts().logger),
    );
    this.diagnostics = this.#diagnosticModel.view;
    this.#activator = new Activator(
      this.#registrations,
      () => this.#requirePorts(),
      () => this.#diagnosticModel.publish(),
    );
    this.#registrationPort = {
      notifyChanged: () => {
        const platform = authority.current;
        if (platform) platform.#diagnosticModel.publish();
      },
      change: () => requirePlatform(authority).change(),
      settled: () => requirePlatform(authority).#changeQueue.settled,
      activateRegistration: (registration, signal, permit) => {
        const platform = requirePlatform(authority);
        platform.#assertActive();
        return platform.#activator.activate(registration, signal, permit);
      },
    };
    this.#changePort = {
      normalize: (artifact) => {
        const platform = requirePlatform(authority);
        return normalizeArtifact(platform.apiVersion, artifact);
      },
      createRegistration: (artifact) => requirePlatform(authority).#createRegistration(artifact),
      attachRegistration: (registration) =>
        requirePlatform(authority).#attachRegistration(registration),
      resolve: (registration) => requirePlatform(authority).#resolve(registration),
      execute: (operations) => requirePlatform(authority).#execute(operations),
    };
    Object.freeze(this);
  }

  get status() {
    return this.#state.phase;
  }

  async register(artifact: Artifact<Reference>) {
    const change = this.change();
    const registration = change.register(artifact);
    await change.commit();
    return registration;
  }

  change(): PlatformChangeSet<Reference> {
    this.#assertActive();
    return new PlatformChangeSetDraft(this.#changePort);
  }

  async trigger(event: string) {
    this.#assertActive();
    if (typeof event !== "string" || !event.trim()) {
      throw new TypeError("Activation event must be a non-empty string");
    }
    if (event !== event.trim()) {
      throw new TypeError("Activation event cannot start or end with whitespace");
    }
    const selected = [...this.#registrations.values()].filter((registration) => {
      return registration.manifest.activation.includes(event);
    });
    const results = await Promise.allSettled(
      selected.map((registration) => registration.activate()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result): unknown => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Activation '${event}' failed`);
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();

    const completion = this.#changeQueue.run(() => this.#disposeRegistrations());
    this.#state = { phase: "disposing", ports: state.ports, completion };
    this.#changeController?.abort();
    for (const registration of this.#registrations.values()) registration.cancelActivation();
    this.#diagnosticModel.publish();
    return completion;
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }

  #createRegistration(artifact: NormalizedArtifact<Reference>): RegistrationRecord<Reference> {
    const registration: RegistrationRecord<Reference> = new RegistrationRecord(artifact);
    this.#ownedRegistrations.set(registration.facade, registration);
    return registration;
  }

  #attachRegistration(registration: RegistrationRecord<Reference>) {
    this.#assertActive();
    registration.attach(this.#registrationPort);
  }

  #resolve(value: Registration<Reference>) {
    const registration =
      value && typeof value === "object"
        ? this.#ownedRegistrations.get(value as object)
        : undefined;
    if (!registration) {
      throw new TypeError("Registration belongs to a different Platform");
    }
    if (!registration.hasAuthority) throw registration.unavailableError();
    return registration;
  }

  #execute(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const registrations = operations
      .filter(
        (
          operation,
        ): operation is Extract<PlatformChangeOperation<Reference>, { kind: "register" }> => {
          return operation.kind === "register";
        },
      )
      .map((operation) => operation.registration);

    return this.#changeQueue.run(async () => {
      try {
        this.#assertActive();
        const pending = operations.filter(
          (operation) =>
            operation.kind !== "remove" ||
            this.#registrations.get(operation.registration.manifestName) === operation.registration,
        );
        if (!pending.length) return;
        await this.#applyChanges(pending);
      } catch (error) {
        const failure = normalizePlatformOperationFailure(error, "change");
        for (const registration of registrations) registration.discard(failure);
        this.#diagnosticModel.publish();
        throw failure;
      }
    });
  }

  // Validate again after stabilization because earlier in-flight activations may have changed the graph.
  async #applyChanges(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const controller = new AbortController();
    this.#changeController = controller;
    let activationBarrier: ActivationBarrier | undefined;
    try {
      const { installer, loader, authorizer } = this.#requirePorts();
      const plan = this.#planChange(operations);
      validateCandidateGraph(this.#registrations.values(), operations, plan.installedUpdates);
      await this.#authorizeChanges(operations, authorizer, controller.signal);
      const loadedPlugins = await this.#loadUpdatedPlugins(
        operations,
        plan.installedUpdates,
        loader,
        controller.signal,
      );
      controller.signal.throwIfAborted();

      activationBarrier = this.#activator.stabilize(plan.targets);
      await activationBarrier.settled;
      controller.signal.throwIfAborted();
      validateCandidateGraph(this.#registrations.values(), operations, plan.installedUpdates);

      const coreChange = stageCoreChange(installer, operations, loadedPlugins);
      const commitPlatformChange = this.#prepareChangeCommit(
        operations,
        coreChange.registrationStates,
      );
      controller.signal.throwIfAborted();
      await coreChange.commit();
      commitPlatformChange();
      this.#diagnosticModel.publish();
    } finally {
      activationBarrier?.release();
      if (this.#changeController === controller) this.#changeController = undefined;
    }
  }

  #planChange(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  ): PlatformChangePlan<Reference> {
    const targets: RegistrationRecord<Reference>[] = [];
    const installedUpdates = new Set<RegistrationRecord<Reference>>();
    for (const operation of operations) {
      if (operation.kind === "register") continue;
      const registration = operation.registration;
      assertCurrentRegistration(this.#registrations, registration);
      targets.push(registration);
      if (operation.kind === "update") registration.assertInstallable();
      if (operation.kind === "update" && registration.status === "installed") {
        installedUpdates.add(registration);
      }
    }
    return { targets, installedUpdates };
  }

  async #authorizeChanges(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    authorizer: Authorizer,
    signal: AbortSignal,
  ) {
    for (const operation of operations) {
      if (operation.kind !== "remove") {
        signal.throwIfAborted();
        try {
          await authorizer.authorize(operation.artifact.manifest, signal);
        } catch (error) {
          throw normalizeRegistrationFailure(error, operation.artifact.manifest.name);
        }
      }
    }
  }

  async #loadUpdatedPlugins(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    installedUpdates: ReadonlySet<RegistrationRecord<Reference>>,
    loader: Loader<Reference>,
    signal: AbortSignal,
  ) {
    const loadedPlugins = new Map<RegistrationRecord<Reference>, AnyPlugin>();
    for (const operation of operations) {
      if (operation.kind === "update" && installedUpdates.has(operation.registration)) {
        loadedPlugins.set(
          operation.registration,
          await loadPlugin(loader, operation.artifact, signal),
        );
      }
    }
    return loadedPlugins;
  }

  #prepareChangeCommit(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    registrationStates: ReturnType<typeof stageCoreChange<Reference>>["registrationStates"],
  ) {
    const registrationCommits = registrationStates.map(({ operation, state }) => ({
      operation,
      commit: operation.registration.prepareCommit(operation.artifact, state),
    }));
    return () => {
      for (const operation of operations) {
        if (operation.kind === "remove") {
          this.#registrations.delete(operation.registration.manifestName);
          operation.registration.markRemoved();
        }
      }
      for (const { operation, commit } of registrationCommits) {
        if (operation.kind === "register") {
          this.#registrations.set(operation.registration.manifestName, operation.registration);
        }
        commit();
      }
    };
  }

  #assertActive() {
    const status = this.#state.phase;
    if (status !== "active") {
      throw new PlatformError("PLATFORM_UNAVAILABLE", `Platform is ${status}`);
    }
  }

  #requirePorts() {
    const ports = this.#livePorts();
    if (!ports) throw new PlatformError("PLATFORM_UNAVAILABLE", "Platform is disposed");
    return ports;
  }

  #livePorts() {
    const state = this.#state;
    return state.phase === "disposed" ? undefined : state.ports;
  }

  // Await activations before removal to prevent late commits; failed removal must retain active ownership.
  async #disposeRegistrations() {
    const ports = this.#requirePorts();
    const registrations = [...this.#registrations.values()];
    for (const registration of registrations) registration.cancelActivation();
    await Promise.all(registrations.map((registration) => registration.whenActivationSettled()));

    try {
      const installations = registrations.flatMap((registration) => {
        const installation = registration.installation;
        return installation && installation.status !== "removed" ? [installation] : [];
      });
      if (installations.length) {
        const change = ports.installer.change();
        for (const installation of installations) change.remove(installation);
        await change.commit();
      }
      this.#registrations.clear();
      for (const registration of registrations) registration.markRemoved();
      this.#state = { phase: "disposed" };
      this.#diagnosticModel.publish();
      this.#diagnosticModel.dispose();
      this.#authority.current = undefined;
    } catch (error) {
      this.#state = { phase: "active", ports };
      this.#diagnosticModel.publish();
      throw normalizePlatformOperationFailure(error, "disposal");
    }
  }
}

export function createPlatform<Reference>(
  options: PlatformOptions<Reference>,
): Platform<Reference> {
  return new PlatformImpl(options);
}

function requirePlatform<Reference>(authority: PlatformAuthority<Reference>) {
  const platform = authority.current;
  if (!platform) {
    throw new PlatformError("PLATFORM_UNAVAILABLE", "Platform is disposed");
  }
  return platform;
}

function normalizePlatformOperationFailure(error: unknown, operation: "change" | "disposal") {
  if (isError(error)) return error;
  return new TypeError(`Platform ${operation} failed with a non-Error value`, { cause: error });
}

function createDiagnosticReporter(logger: Logger) {
  return (error: unknown) => {
    try {
      const result: unknown = logger.error(error);
      // The terminal logger has no lower sink, but its rejection must be observed.
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Diagnostics must not mutate the command being observed.
    }
  };
}
