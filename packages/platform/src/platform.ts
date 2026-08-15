import {
  type Logger,
  type Installer,
  type Provisions,
  type Requirements,
  SerialQueue,
  type SnapshotView,
} from "@dougongjs/core";
import { validate } from "compare-versions";
import { loadPluginDefinition, normalizeArtifact } from "./artifact";
import { validateCandidateGraph } from "./candidate-graph";
import { stageCoreChange } from "./core-change";
import { PlatformDiagnostics, type PlatformSnapshot } from "./diagnostics";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import { RegistrationRecord, type RegistrationRecordOwner } from "./registration";
import { matchesVersion } from "./manifest";
import {
  PlatformChangeSetDraft,
  type PlatformChangeOperation,
  type PlatformChangePort,
} from "./platform-change-set";
import type {
  AnyPlugin,
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
  readonly permissions: Authorizer;
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
  readonly #registrationOwner: RegistrationRecordOwner<Reference>;
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
      options.permissions !== undefined &&
      (!options.permissions || typeof options.permissions.authorize !== "function")
    ) {
      throw new TypeError("Platform permissions must implement authorize()");
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
        permissions: options.permissions ?? new PermissionSet(),
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
    this.#registrationOwner = {
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
      resolve: (plugin) => requirePlatform(authority).#resolve(plugin),
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
    const plugin = change.register(artifact);
    await change.commit();
    return plugin;
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

    const completion = this.#changeQueue.settled.then(() => this.#disposeRegistrations());
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
    this.#ownedRegistrations.set(registration.handle, registration);
    return registration;
  }

  #attachRegistration(registration: RegistrationRecord<Reference>) {
    registration.attach(this.#registrationOwner);
  }

  #resolve(plugin: Registration<Reference>) {
    const registration =
      plugin && typeof plugin === "object"
        ? this.#ownedRegistrations.get(plugin as object)
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
        `Registration '${registration.name}' is being changed`,
      );
    }
    if (registration.status === "activated") return;
    if (stack.includes(registration)) {
      throw new PlatformError(
        "PLUGIN_CYCLE",
        `Plugin dependency cycle: ${[...stack, registration].map((item) => item.name).join(" -> ")}`,
      );
    }

    registration.beginActivation();
    this.#publish();
    try {
      const { installer, permissions } = this.#requirePorts();
      await permissions.authorize(registration.manifest, signal);
      await this.#activateDependencies(registration, [...stack, registration], signal);
      const definition = await loadPluginDefinition(
        this.#requirePorts().loader,
        registration.artifact,
        signal,
      );
      const change = installer.change();
      let handle = registration.coreHandle;
      if (handle)
        change.update(handle, { plugin: definition, config: registration.artifact.config });
      else handle = change.install(definition, registration.artifact.config);
      await change.commit();
      registration.commitActivation(handle);
      this.#publish();
    } catch (error) {
      registration.fail(error);
      this.#publish();
      throw error;
    }
  }

  async #applyChanges(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const targets = this.#lockChangeTargets(operations);
    const controller = new AbortController();
    this.#changeController = controller;
    try {
      const { installer, permissions } = this.#requirePorts();
      await Promise.all(targets.map((registration) => registration.whenActivationSettled()));
      controller.signal.throwIfAborted();
      validateCandidateGraph(this.#registrations.values(), operations);
      await this.#authorizeChanges(operations, permissions, controller.signal);
      const definitions = await this.#loadUpdatedDefinitions(operations, controller.signal);
      const coreChange = stageCoreChange(installer, operations, definitions);
      const commitPlatformChange = this.#prepareChangeCommit(operations, coreChange.artifactStates);
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
    permissions: Authorizer,
    signal: AbortSignal,
  ) {
    for (const operation of operations) {
      if (operation.kind !== "remove") {
        await permissions.authorize(operation.artifact.manifest, signal);
      }
    }
  }

  async #loadUpdatedDefinitions(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    signal: AbortSignal,
  ) {
    const definitions = new Map<RegistrationRecord<Reference>, AnyPlugin>();
    for (const operation of operations) {
      if (operation.kind === "update" && operation.registration.status === "activated") {
        definitions.set(
          operation.registration,
          await loadPluginDefinition(this.#requirePorts().loader, operation.artifact, signal),
        );
      }
    }
    return definitions;
  }

  #prepareChangeCommit(
    operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
    artifactStates: ReturnType<typeof stageCoreChange<Reference>>["artifactStates"],
  ) {
    const artifactCommits = artifactStates.map(({ operation, state }) => ({
      operation,
      commit: operation.registration.prepareArtifactCommit(operation.artifact, state),
    }));
    return () => {
      for (const operation of operations) {
        if (operation.kind === "remove") {
          this.#registrations.delete(operation.registration.name);
          operation.registration.markRemoved();
        }
      }
      for (const { operation, commit } of artifactCommits) {
        if (operation.kind === "register") {
          this.#registrations.set(operation.registration.name, operation.registration);
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
          "PLUGIN_DEPENDENCY_MISSING",
          `Plugin '${registration.name}' requires missing plugin '${name}'`,
        );
      }
      if (!matchesVersion(dependency.manifest.version, range)) {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_INCOMPATIBLE",
          `Plugin '${registration.name}' requires '${name}' ${range}, found ${dependency.manifest.version}`,
        );
      }
      if (stack.includes(dependency)) {
        throw new PlatformError(
          "PLUGIN_CYCLE",
          `Plugin dependency cycle: ${[...stack, dependency]
            .map((item) => item.name)
            .join(" -> ")}`,
        );
      }
      await dependency.activateAsDependency(stack);
    }
  }

  #assertActive() {
    const status = this.#state.phase;
    if (status !== "active") {
      throw new PlatformError("PLATFORM_UNAVAILABLE", `Plugin platform is ${status}`);
    }
  }

  #assertRegistered(registration: RegistrationRecord<Reference>) {
    if (
      this.#registrations.get(registration.name) !== registration ||
      registration.status === "removed"
    ) {
      throw new PlatformError(
        "REGISTRATION_REMOVED",
        `Registration '${registration.name}' has been removed`,
      );
    }
  }

  #requirePorts() {
    const ports = this.#livePorts();
    if (!ports) throw new PlatformError("PLATFORM_UNAVAILABLE", "Plugin platform is disposed");
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
      const handles = registrations.flatMap((registration) => {
        const handle = registration.coreHandle;
        return handle && handle.status !== "removed" ? [handle] : [];
      });
      if (handles.length) {
        const change = ports.installer.change();
        for (const handle of handles) change.remove(handle);
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

function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Logger>;
  return [candidate.debug, candidate.info, candidate.warn, candidate.error].every(
    (method) => typeof method === "function",
  );
}

function requirePlatform<Reference>(authority: PlatformAuthority<Reference>) {
  const platform = authority.current;
  if (!platform) {
    throw new PlatformError("PLATFORM_UNAVAILABLE", "Plugin platform is disposed");
  }
  return platform;
}
