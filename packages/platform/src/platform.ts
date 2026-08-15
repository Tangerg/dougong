import {
  type Logger,
  type Installer,
  type Provisions,
  type Requirements,
  isLogger,
  SerialQueue,
  type SnapshotView,
} from "@dougongjs/core";
import { validate } from "compare-versions";
import { loadPlugin, normalizeArtifact } from "./artifact";
import { validateCandidateGraph } from "./candidate-graph";
import { stageCoreChange } from "./core-change";
import { PlatformDiagnostics, type PlatformSnapshot } from "./diagnostics";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import {
  normalizeRegistrationFailure,
  RegistrationRecord,
  type RegistrationPort,
} from "./registration";
import { matchesVersion } from "./manifest";
import {
  PlatformChangeSetDraft,
  type PlatformChangeOperation,
  type PlatformChangePort,
} from "./platform-change-set";
import type {
  ErasedPlugin,
  PlatformOptions,
  Registration,
  NormalizedArtifact,
  PlatformChangeSet,
  Artifact,
  Platform,
} from "./platform-api";
import { PermissionSet, type Authorizer } from "./permissions";

interface PlatformAuthority<Reference> {
  current: PlatformImpl<Reference> | undefined;
}

interface PlatformPorts<Reference> {
  readonly installer: Installer;
  readonly loader: Loader<Reference>;
  readonly authorizer: Authorizer;
  readonly logger: Logger;
}

type PlatformState<Reference> =
  | { readonly phase: "active"; readonly ports: PlatformPorts<Reference> }
  | {
      readonly phase: "disposing";
      readonly ports: PlatformPorts<Reference>;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed" };

class PlatformImpl<Reference> implements Platform<Reference> {
  readonly #registrations = new Map<string, RegistrationRecord<Reference>>();
  readonly #ownedRegistrations = new WeakMap<object, RegistrationRecord<Reference>>();
  readonly #lockedRegistrations = new Set<RegistrationRecord<Reference>>();
  readonly #diagnosticModel: PlatformDiagnostics;
  readonly #registrationPort: RegistrationPort<Reference>;
  readonly #changePort: PlatformChangePort<Reference>;
  readonly #authority: PlatformAuthority<Reference>;
  readonly #changeQueue = new SerialQueue();
  #state: PlatformState<Reference>;
  #changeController: AbortController | undefined;

  readonly apiVersion: string;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;

  constructor(options: PlatformOptions<Reference>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Platform options must be an object");
    }
    if (typeof options.apiVersion !== "string" || !validate(options.apiVersion)) {
      throw new TypeError("Platform apiVersion must be a semantic version");
    }
    if (!options.installer || typeof options.installer.change !== "function") {
      throw new TypeError("Platform installer must implement change()");
    }
    if (!options.loader || typeof options.loader.load !== "function") {
      throw new TypeError("Platform loader must implement load()");
    }
    if (
      options.authorizer !== undefined &&
      (!options.authorizer || typeof options.authorizer.authorize !== "function")
    ) {
      throw new TypeError("Platform authorizer must implement authorize()");
    }
    if (options.logger !== undefined && !isLogger(options.logger)) {
      throw new TypeError("Platform logger must implement debug/info/warn/error");
    }
    const authority: PlatformAuthority<Reference> = { current: this };
    this.#authority = authority;
    this.apiVersion = options.apiVersion;
    this.#state = {
      phase: "active",
      ports: Object.freeze({
        installer: options.installer,
        loader: options.loader,
        authorizer: options.authorizer ?? new PermissionSet(),
        logger: options.logger ?? console,
      }),
    };
    this.#diagnosticModel = new PlatformDiagnostics(this.apiVersion, (error) => {
      const platform = authority.current;
      if (!platform) return;
      const ports = platform.#livePorts();
      if (!ports) return;
      try {
        ports.logger.error(error);
      } catch {
        // Diagnostics are observation-only and cannot fail a platform command.
      }
    });
    this.diagnostics = this.#diagnosticModel.view;
    this.#registrationPort = {
      change: () => requirePlatform(authority).change(),
      activateRegistration: (registration, stack, signal) => {
        return requirePlatform(authority).#activateRegistration(registration, stack, signal);
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

  async register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>) {
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
    if (typeof event !== "string" || !event.trim() || event !== event.trim()) {
      throw new TypeError("Activation event must be a non-empty, trimmed string");
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
    this.#publish();
    return completion;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }

  #createRegistration(artifact: NormalizedArtifact<Reference>): RegistrationRecord<Reference> {
    const registration: RegistrationRecord<Reference> = new RegistrationRecord(artifact);
    this.#ownedRegistrations.set(registration.publicRegistration, registration);
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

    return this.#enqueueChange(async () => {
      this.#assertActive();
      try {
        await this.#applyChanges(operations);
      } catch (error) {
        for (const registration of registrations) registration.discard(error);
        this.#publish();
        throw error;
      }
    });
  }

  async #activateRegistration(
    registration: RegistrationRecord<Reference>,
    stack: ReadonlyArray<RegistrationRecord<Reference>>,
    signal: AbortSignal,
  ) {
    this.#assertActive();
    this.#assertRegistered(registration);
    if (this.#lockedRegistrations.has(registration)) {
      throw new PlatformError(
        "REGISTRATION_BUSY",
        `Registration '${registration.manifestName}' is being changed`,
      );
    }
    if (registration.status === "activated") return;
    if (stack.includes(registration)) {
      throw new PlatformError(
        "REGISTRATION_CYCLE",
        `Registration dependency cycle: ${[...stack, registration]
          .map((item) => item.manifestName)
          .join(" -> ")}`,
      );
    }

    registration.beginActivation();
    this.#publish();
    try {
      const { installer, authorizer } = this.#requirePorts();
      await authorizer.authorize(registration.manifest, signal);
      await this.#activateDependencies(registration, [...stack, registration], signal);
      const plugin = await loadPlugin(this.#requirePorts().loader, registration.artifact, signal);
      const change = installer.change();
      let installation = registration.installation;
      if (installation) {
        change.update(installation, { plugin, config: registration.artifact.config });
      } else {
        installation = change.install(plugin, registration.artifact.config);
      }
      await change.commit();
      registration.commitActivation(installation);
      this.#publish();
    } catch (error) {
      const failure = registration.fail(error);
      this.#publish();
      throw failure;
    }
  }

  async #applyChanges(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const targets = this.#lockChangeTargets(operations);
    const controller = new AbortController();
    this.#changeController = controller;
    try {
      const { installer, authorizer } = this.#requirePorts();
      await Promise.all(targets.map((registration) => registration.whenActivationSettled()));
      controller.signal.throwIfAborted();
      validateCandidateGraph(this.#registrations.values(), operations);
      await this.#authorizeChanges(operations, authorizer, controller.signal);
      const loadedPlugins = await this.#loadUpdatedPlugins(operations, controller.signal);
      const coreChange = stageCoreChange(installer, operations, loadedPlugins);
      const commitPlatformChange = this.#prepareChangeCommit(
        operations,
        coreChange.registrationStates,
      );
      await coreChange.commit();
      commitPlatformChange();
      this.#publish();
    } finally {
      for (const registration of targets) this.#lockedRegistrations.delete(registration);
      if (this.#changeController === controller) this.#changeController = undefined;
    }
  }

  #lockChangeTargets(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const targets: RegistrationRecord<Reference>[] = [];
    for (const operation of operations) {
      if (operation.kind === "register") continue;
      if (operation.kind === "remove" && operation.registration.status === "removed") continue;
      const registration = operation.registration;
      this.#assertRegistered(registration);
      this.#lockedRegistrations.add(registration);
      registration.cancelActivation();
      targets.push(registration);
    }
    return targets;
  }

  async #authorizeChanges(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    authorizer: Authorizer,
    signal: AbortSignal,
  ) {
    for (const operation of operations) {
      if (operation.kind !== "remove") {
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
    signal: AbortSignal,
  ) {
    const loadedPlugins = new Map<RegistrationRecord<Reference>, ErasedPlugin>();
    for (const operation of operations) {
      if (operation.kind === "update" && operation.registration.status === "activated") {
        loadedPlugins.set(
          operation.registration,
          await loadPlugin(this.#requirePorts().loader, operation.artifact, signal),
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

  async #activateDependencies(
    registration: RegistrationRecord<Reference>,
    stack: ReadonlyArray<RegistrationRecord<Reference>>,
    signal: AbortSignal,
  ) {
    for (const [name, range] of Object.entries(registration.manifest.dependencies)) {
      signal.throwIfAborted();
      const dependency = this.#registrations.get(name);
      if (!dependency) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_MISSING",
          `Registration '${registration.manifestName}' requires missing Registration '${name}'`,
        );
      }
      if (!matchesVersion(dependency.manifest.version, range)) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
          `Registration '${registration.manifestName}' requires Registration '${name}' ${range}, found ${dependency.manifest.version}`,
        );
      }
      if (stack.includes(dependency)) {
        throw new PlatformError(
          "REGISTRATION_CYCLE",
          `Registration dependency cycle: ${[...stack, dependency]
            .map((item) => item.manifestName)
            .join(" -> ")}`,
        );
      }
      await dependency.activateAsDependency(stack);
    }
  }

  #assertActive() {
    const status = this.#state.phase;
    if (status !== "active") {
      throw new PlatformError("PLATFORM_UNAVAILABLE", `Platform is ${status}`);
    }
  }

  #assertRegistered(registration: RegistrationRecord<Reference>) {
    if (
      this.#registrations.get(registration.manifestName) !== registration ||
      registration.status === "removed"
    ) {
      throw registration.unavailableError();
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

  #publish() {
    this.#diagnosticModel.publish(this.#state.phase, this.#registrations.values());
  }

  #enqueueChange(operation: () => Promise<void>) {
    return this.#changeQueue.run(operation);
  }

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
      this.#publish();
      this.#diagnosticModel.dispose();
      this.#authority.current = undefined;
    } catch (error) {
      this.#state = { phase: "active", ports };
      this.#publish();
      throw error;
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
