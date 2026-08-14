import {
  definePlugin,
  type Logger,
  type PluginChangeSet,
  type PluginContainer,
  type PluginHandle,
  type Provisions,
  type Requirements,
  type SnapshotView,
} from "@dougong/core";
import { validate } from "compare-versions";
import {
  PlatformDiagnostics,
  type PluginPlatformSnapshot,
  type PluginPlatformStatus,
} from "./diagnostics";
import { PlatformError } from "./errors";
import type { PluginLoader } from "./loader";
import { ManagedPluginRegistration, type ManagedPluginRegistrationOwner } from "./managed-plugin";
import { defineManifest, matchesVersion, type PluginManifest } from "./manifest";
import {
  PlatformChangeSetDraft,
  type CandidateRegistration,
  type PlatformChangeOperation,
  type PlatformChangeHost,
} from "./platform-change-set";
import type {
  AnyPluginDefinition,
  CreatePlatformOptions,
  ManagedPlugin,
  NormalizedArtifact,
  PlatformChangeSet,
  PluginArtifact,
  PluginPlatform,
} from "./platform-api";
import { PermissionSet, type PermissionAuthorizer } from "./permissions";

interface PlatformAuthority<Reference> {
  current: PluginPlatformImpl<Reference> | undefined;
}

interface PlatformPorts<Reference> {
  readonly container: PluginContainer;
  readonly loader: PluginLoader<Reference>;
  readonly permissions: PermissionAuthorizer;
  readonly logger: Logger;
}

class PluginPlatformImpl<Reference> implements PluginPlatform<Reference> {
  #ports: PlatformPorts<Reference> | undefined;
  readonly #registrations = new Map<string, ManagedPluginRegistration<Reference>>();
  readonly #ownedRegistrations = new WeakMap<object, ManagedPluginRegistration<Reference>>();
  readonly #lockedRegistrations = new Set<ManagedPluginRegistration<Reference>>();
  readonly #diagnosticModel: PlatformDiagnostics;
  readonly #registrationOwner: ManagedPluginRegistrationOwner<Reference>;
  readonly #changeHost: PlatformChangeHost<Reference>;
  readonly #authority: PlatformAuthority<Reference>;
  #status: PluginPlatformStatus = "active";
  #changeQueue: Promise<void> = Promise.resolve();
  #changeController: AbortController | undefined;
  #disposePromise: Promise<void> | undefined;

  readonly apiVersion: string;
  readonly diagnostics: SnapshotView<PluginPlatformSnapshot>;

  constructor(options: CreatePlatformOptions<Reference>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Platform options must be an object");
    }
    if (typeof options.apiVersion !== "string" || !validate(options.apiVersion)) {
      throw new TypeError("Platform apiVersion must be a semantic version");
    }
    if (!options.container || typeof options.container.change !== "function") {
      throw new TypeError("Platform container must implement change()");
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
    this.#ports = Object.freeze({
      container: options.container,
      loader: options.loader,
      permissions: options.permissions ?? new PermissionSet(),
      logger: options.logger ?? console,
    });
    this.#diagnosticModel = new PlatformDiagnostics(this.apiVersion, (error) => {
      const platform = authority.current;
      if (!platform) return;
      const ports = platform.#ports;
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
    this.#changeHost = {
      normalize: (artifact) => requirePlatform(authority).#normalize(artifact),
      createRegistration: (artifact) => requirePlatform(authority).#createRegistration(artifact),
      attachRegistration: (registration) =>
        requirePlatform(authority).#attachRegistration(registration),
      resolve: (plugin) => requirePlatform(authority).#resolve(plugin),
      execute: (operations) => requirePlatform(authority).#execute(operations),
    };
    Object.freeze(this);
  }

  get status() {
    return this.#status;
  }

  async register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>) {
    const change = this.change();
    const plugin = change.register(artifact);
    await change.commit();
    return plugin;
  }

  change(): PlatformChangeSet<Reference> {
    this.#assertActive();
    return new PlatformChangeSetDraft(this.#changeHost);
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
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#status === "disposed") return Promise.resolve();

    this.#status = "disposing";
    this.#changeController?.abort();
    for (const registration of this.#registrations.values()) registration.cancelActivation();
    this.#publish();
    this.#disposePromise = this.#changeQueue.then(() => this.#disposeRegistrations());
    return this.#disposePromise;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }

  #createRegistration(
    artifact: NormalizedArtifact<Reference>,
  ): ManagedPluginRegistration<Reference> {
    const registration: ManagedPluginRegistration<Reference> = new ManagedPluginRegistration(
      artifact,
    );
    this.#ownedRegistrations.set(registration.handle, registration);
    return registration;
  }

  #attachRegistration(registration: ManagedPluginRegistration<Reference>) {
    registration.attach(this.#registrationOwner);
  }

  #resolve(plugin: ManagedPlugin<Reference>) {
    const registration =
      plugin && typeof plugin === "object"
        ? this.#ownedRegistrations.get(plugin as object)
        : undefined;
    if (!registration) {
      throw new TypeError("ManagedPlugin belongs to a different PluginPlatform");
    }
    return registration;
  }

  #normalize<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): NormalizedArtifact<Reference> {
    if (!artifact || typeof artifact !== "object") {
      throw new TypeError("Plugin artifact must be an object");
    }
    const manifest = defineManifest(artifact.manifest);
    if (!matchesVersion(this.apiVersion, manifest.apiVersion)) {
      throw new PlatformError(
        "API_INCOMPATIBLE",
        `Plugin '${manifest.name}' requires API ${manifest.apiVersion}, host is ${this.apiVersion}`,
      );
    }

    const placeholder =
      artifact.placeholder === undefined
        ? undefined
        : this.#normalizePlaceholder(manifest, artifact.placeholder);
    return Object.freeze({
      manifest,
      reference: artifact.reference,
      config: artifact.config,
      ...(placeholder ? { placeholder } : {}),
    });
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
    registration: ManagedPluginRegistration<Reference>,
    stack: ReadonlyArray<ManagedPluginRegistration<Reference>>,
    signal: AbortSignal,
  ) {
    this.#assertActive();
    this.#assertRegistered(registration);
    if (this.#lockedRegistrations.has(registration)) {
      throw new PlatformError("PLUGIN_BUSY", `Plugin '${registration.name}' is being changed`);
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
      const { container, permissions } = this.#requirePorts();
      await permissions.authorize(registration.manifest, signal);
      await this.#activateDependencies(registration, [...stack, registration], signal);
      const definition = await this.#loadDefinition(registration.artifact, signal);
      const change = container.change();
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
    const targets: ManagedPluginRegistration<Reference>[] = [];
    for (const operation of operations) {
      if (operation.kind === "register") continue;
      if (operation.kind === "remove" && operation.registration.status === "removed") continue;
      const registration = operation.registration;
      this.#assertRegistered(registration);
      this.#lockedRegistrations.add(registration);
      registration.cancelActivation();
      targets.push(registration);
    }

    const controller = new AbortController();
    this.#changeController = controller;
    try {
      const { container, permissions } = this.#requirePorts();
      await Promise.all(targets.map((registration) => registration.whenActivationSettled()));
      controller.signal.throwIfAborted();

      const candidate = this.#buildCandidate(operations);
      this.#validateCandidate(candidate);

      for (const operation of operations) {
        if (operation.kind !== "remove") {
          await permissions.authorize(operation.artifact.manifest, controller.signal);
        }
      }

      const definitions = new Map<ManagedPluginRegistration<Reference>, AnyPluginDefinition>();
      for (const operation of operations) {
        if (operation.kind === "update" && operation.registration.status === "activated") {
          definitions.set(
            operation.registration,
            await this.#loadDefinition(operation.artifact, controller.signal),
          );
        }
      }

      let coreChange: PluginChangeSet | undefined;
      const getCoreChange = () => (coreChange ??= container.change());
      const handles = new Map<ManagedPluginRegistration<Reference>, PluginHandle | undefined>();
      for (const operation of operations) {
        if (operation.kind === "register") {
          const handle = operation.artifact.placeholder
            ? getCoreChange().install(operation.artifact.placeholder, operation.artifact.config)
            : undefined;
          handles.set(operation.registration, handle);
          continue;
        }

        const current = operation.registration.coreHandle;
        if (operation.kind === "remove") {
          if (current && current.status !== "removed") getCoreChange().remove(current);
          continue;
        }

        const definition = definitions.get(operation.registration);
        if (definition && current) {
          getCoreChange().update(current, {
            plugin: definition,
            config: operation.artifact.config,
          });
          handles.set(operation.registration, current);
        } else if (definition) {
          handles.set(
            operation.registration,
            getCoreChange().install(definition, operation.artifact.config),
          );
        } else if (current && operation.artifact.placeholder) {
          getCoreChange().update(current, {
            plugin: operation.artifact.placeholder,
            config: operation.artifact.config,
          });
          handles.set(operation.registration, current);
        } else if (current) {
          if (current.status !== "removed") getCoreChange().remove(current);
          handles.set(operation.registration, undefined);
        } else if (operation.artifact.placeholder) {
          handles.set(
            operation.registration,
            getCoreChange().install(operation.artifact.placeholder, operation.artifact.config),
          );
        }
      }
      await coreChange?.commit();

      for (const operation of operations) {
        if (operation.kind === "remove") {
          this.#registrations.delete(operation.registration.name);
          operation.registration.markRemoved();
          continue;
        }
        if (operation.kind === "register") {
          this.#registrations.set(operation.registration.name, operation.registration);
        }
        operation.registration.commitArtifact(
          operation.artifact,
          handles.get(operation.registration),
          operation.kind === "update" && definitions.has(operation.registration),
        );
      }
      this.#publish();
    } finally {
      for (const registration of targets) this.#lockedRegistrations.delete(registration);
      if (this.#changeController === controller) this.#changeController = undefined;
    }
  }

  #buildCandidate(operations: ReadonlyArray<PlatformChangeOperation<Reference>>) {
    const candidate = new Map<string, CandidateRegistration<Reference>>(
      [...this.#registrations.values()].map((registration) => [
        registration.name,
        { registration, artifact: registration.artifact },
      ]),
    );

    for (const operation of operations) {
      if (operation.kind === "register") {
        if (candidate.has(operation.registration.name)) {
          throw new PlatformError(
            "PLUGIN_DUPLICATE",
            `Plugin '${operation.registration.name}' is already registered`,
          );
        }
        candidate.set(operation.registration.name, {
          registration: operation.registration,
          artifact: operation.artifact,
        });
      } else if (operation.kind === "update") {
        candidate.set(operation.registration.name, {
          registration: operation.registration,
          artifact: operation.artifact,
        });
      } else {
        candidate.delete(operation.registration.name);
      }
    }
    return candidate;
  }

  #validateCandidate(candidate: ReadonlyMap<string, CandidateRegistration<Reference>>) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string, path: ReadonlyArray<string>) => {
      if (visiting.has(name)) {
        throw new PlatformError(
          "PLUGIN_CYCLE",
          `Plugin dependency cycle: ${[...path, name].join(" -> ")}`,
        );
      }
      if (visited.has(name)) return;
      const current = candidate.get(name);
      if (!current) return;
      visiting.add(name);
      for (const dependency of Object.keys(current.artifact.manifest.dependencies)) {
        if (candidate.has(dependency)) visit(dependency, [...path, name]);
      }
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of candidate.keys()) visit(name, []);

    for (const { registration, artifact } of candidate.values()) {
      if (registration.status !== "activated") continue;
      for (const [name, range] of Object.entries(artifact.manifest.dependencies)) {
        const dependency = candidate.get(name);
        if (!dependency) {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_MISSING",
            `Activated plugin '${registration.name}' requires missing plugin '${name}'`,
          );
        }
        if (!matchesVersion(dependency.artifact.manifest.version, range)) {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_INCOMPATIBLE",
            `Plugin '${registration.name}' requires '${name}' ${range}, found ${dependency.artifact.manifest.version}`,
          );
        }
        if (dependency.registration.status !== "activated") {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_INACTIVE",
            `Activated plugin '${registration.name}' requires plugin '${name}' to be activated`,
          );
        }
      }
    }
  }

  async #activateDependencies(
    registration: ManagedPluginRegistration<Reference>,
    stack: ReadonlyArray<ManagedPluginRegistration<Reference>>,
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

  async #loadDefinition(artifact: NormalizedArtifact<Reference>, signal: AbortSignal) {
    signal.throwIfAborted();
    let loaded: unknown;
    try {
      loaded = await this.#requirePorts().loader.load(artifact.reference, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new PlatformError(
        "MODULE_LOAD_FAILED",
        `Failed to load plugin '${artifact.manifest.name}'`,
        { cause: error },
      );
    }
    signal.throwIfAborted();
    if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
      throw new PlatformError("MODULE_INVALID", `Plugin '${artifact.manifest.name}' has no module`);
    }
    const candidate = (loaded as { default?: unknown }).default;
    let definition: AnyPluginDefinition;
    try {
      definition = definePlugin(candidate as AnyPluginDefinition);
    } catch (error) {
      throw new PlatformError(
        "MODULE_INVALID",
        `Plugin '${artifact.manifest.name}' default export is not a plugin definition`,
        { cause: error },
      );
    }
    if (definition.name !== artifact.manifest.name) {
      throw new PlatformError(
        "PLUGIN_IDENTITY",
        `Manifest '${artifact.manifest.name}' loaded plugin '${definition.name}'`,
      );
    }
    return definition;
  }

  #normalizePlaceholder(manifest: PluginManifest, placeholder: unknown) {
    const definition = definePlugin(placeholder as AnyPluginDefinition);
    if (definition.name !== manifest.name) {
      throw new PlatformError(
        "PLUGIN_IDENTITY",
        `Manifest '${manifest.name}' placeholder is named '${definition.name}'`,
      );
    }
    return definition;
  }

  #assertActive() {
    if (this.#status !== "active") {
      throw new PlatformError("PLATFORM_UNAVAILABLE", `Plugin platform is ${this.#status}`);
    }
  }

  #assertRegistered(registration: ManagedPluginRegistration<Reference>) {
    if (
      this.#registrations.get(registration.name) !== registration ||
      registration.status === "removed"
    ) {
      throw new PlatformError("PLUGIN_REMOVED", `Plugin '${registration.name}' has been removed`);
    }
  }

  #requirePorts() {
    const ports = this.#ports;
    if (!ports) throw new PlatformError("PLATFORM_UNAVAILABLE", "Plugin platform is disposed");
    return ports;
  }

  #publish() {
    this.#diagnosticModel.publish(this.#status, this.#registrations.values());
  }

  #enqueueChange(operation: () => Promise<void>) {
    const result = this.#changeQueue.then(operation, operation);
    this.#changeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #disposeRegistrations() {
    const registrations = [...this.#registrations.values()];
    for (const registration of registrations) registration.cancelActivation();
    await Promise.all(registrations.map((registration) => registration.whenActivationSettled()));

    try {
      const handles = registrations.flatMap((registration) => {
        const handle = registration.coreHandle;
        return handle && handle.status !== "removed" ? [handle] : [];
      });
      if (handles.length) {
        const change = this.#requirePorts().container.change();
        for (const handle of handles) change.remove(handle);
        await change.commit();
      }
      this.#registrations.clear();
      for (const registration of registrations) registration.markRemoved();
      this.#status = "disposed";
      this.#publish();
      this.#diagnosticModel.close();
      this.#authority.current = undefined;
      this.#ports = undefined;
    } catch (error) {
      this.#status = "active";
      this.#disposePromise = undefined;
      this.#publish();
      throw error;
    }
  }
}

export function createPlatform<Reference>(
  options: CreatePlatformOptions<Reference>,
): PluginPlatform<Reference> {
  return new PluginPlatformImpl(options);
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
