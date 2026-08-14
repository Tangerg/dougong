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
import { ManagedPluginRecord, type ManagedPluginOwner } from "./managed-plugin";
import { defineManifest, matchesVersion, type PluginManifest } from "./manifest";
import {
  PlatformChangeSetDraft,
  type CandidatePlugin,
  type PlatformChange,
  type PlatformChangeHost,
} from "./platform-change-set";
import type {
  AnyDefinition,
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

class PluginPlatformImpl<Reference> implements PluginPlatform<Reference> {
  #container: PluginContainer | undefined;
  #loader: PluginLoader<Reference> | undefined;
  #permissions: PermissionAuthorizer | undefined;
  #logger: Logger | undefined;
  readonly #records = new Map<string, ManagedPluginRecord<Reference>>();
  readonly #ownedRecords = new WeakMap<object, ManagedPluginRecord<Reference>>();
  readonly #lockedRecords = new Set<ManagedPluginRecord<Reference>>();
  readonly #diagnosticModel: PlatformDiagnostics;
  readonly #managedOwner: ManagedPluginOwner<Reference>;
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
    this.#container = options.container;
    this.apiVersion = options.apiVersion;
    this.#loader = options.loader;
    this.#permissions = options.permissions ?? new PermissionSet();
    this.#logger = options.logger ?? console;
    this.#diagnosticModel = new PlatformDiagnostics(this.apiVersion, (error) => {
      const platform = authority.current;
      if (!platform) return;
      try {
        platform.#logger!.error(error);
      } catch {
        // Diagnostics are observation-only and cannot fail a platform command.
      }
    });
    this.diagnostics = this.#diagnosticModel.view;
    this.#managedOwner = {
      change: () => requirePlatform(authority).change(),
      activateRecord: (record, stack, signal) => {
        return requirePlatform(authority).#activateRecord(record, stack, signal);
      },
    };
    this.#changeHost = {
      normalize: (artifact) => requirePlatform(authority).#normalize(artifact),
      createRecord: (artifact) => requirePlatform(authority).#createRecord(artifact),
      attachRecord: (record) => requirePlatform(authority).#attachRecord(record),
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
    const selected = [...this.#records.values()].filter((record) => {
      return record.manifest.activation.includes(event);
    });
    const results = await Promise.allSettled(selected.map((record) => record.activate()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Activation '${event}' failed`);
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#status === "disposed") return Promise.resolve();

    this.#status = "disposing";
    this.#changeController?.abort();
    for (const record of this.#records.values()) record.cancel();
    this.#publish();
    this.#disposePromise = this.#changeQueue.then(() => this.#disposeRecords());
    return this.#disposePromise;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }

  #createRecord(artifact: NormalizedArtifact<Reference>): ManagedPluginRecord<Reference> {
    const record: ManagedPluginRecord<Reference> = new ManagedPluginRecord(artifact);
    this.#ownedRecords.set(record.handle, record);
    return record;
  }

  #attachRecord(record: ManagedPluginRecord<Reference>) {
    record.attach(this.#managedOwner);
  }

  #resolve(plugin: ManagedPlugin<Reference>) {
    const record =
      plugin && typeof plugin === "object" ? this.#ownedRecords.get(plugin as object) : undefined;
    if (!record) {
      throw new TypeError("ManagedPlugin belongs to a different PluginPlatform");
    }
    return record;
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

  #execute(operations: ReadonlyArray<PlatformChange<Reference>>) {
    const registrations = operations
      .filter(
        (operation): operation is Extract<PlatformChange<Reference>, { kind: "register" }> => {
          return operation.kind === "register";
        },
      )
      .map((operation) => operation.record);

    return this.#enqueueChange(async () => {
      this.#assertActive();
      try {
        await this.#applyChanges(operations);
      } catch (error) {
        for (const record of registrations) record.abandon(error);
        this.#publish();
        throw error;
      }
    });
  }

  async #activateRecord(
    record: ManagedPluginRecord<Reference>,
    stack: ReadonlyArray<ManagedPluginRecord<Reference>>,
    signal: AbortSignal,
  ) {
    this.#assertActive();
    this.#assertManaged(record);
    if (this.#lockedRecords.has(record)) {
      throw new PlatformError("PLUGIN_BUSY", `Plugin '${record.name}' is being changed`);
    }
    if (record.status === "active") return;
    if (stack.includes(record)) {
      throw new PlatformError(
        "PLUGIN_CYCLE",
        `Plugin dependency cycle: ${[...stack, record].map((item) => item.name).join(" -> ")}`,
      );
    }

    record.loading();
    this.#publish();
    try {
      await this.#permissions!.authorize(record.manifest, signal);
      await this.#activateDependencies(record, [...stack, record], signal);
      const definition = await this.#loadDefinition(record.artifact, signal);
      const change = this.#container!.change();
      let handle = record.coreHandle;
      if (handle) change.update(handle, { plugin: definition, config: record.artifact.config });
      else handle = change.install(definition, record.artifact.config);
      await change.commit();
      record.activated(handle);
      this.#publish();
    } catch (error) {
      record.failed(error);
      this.#publish();
      throw error;
    }
  }

  async #applyChanges(operations: ReadonlyArray<PlatformChange<Reference>>) {
    const targets: ManagedPluginRecord<Reference>[] = [];
    for (const operation of operations) {
      if (operation.kind === "register") continue;
      if (operation.kind === "remove" && operation.record.status === "removed") continue;
      const record = operation.record;
      this.#assertManaged(record);
      this.#lockedRecords.add(record);
      record.cancel();
      targets.push(record);
    }

    const controller = new AbortController();
    this.#changeController = controller;
    try {
      await Promise.all(targets.map((record) => record.settled()));
      controller.signal.throwIfAborted();

      const candidate = this.#buildCandidate(operations);
      this.#validateCandidate(candidate);

      for (const operation of operations) {
        if (operation.kind !== "remove") {
          await this.#permissions!.authorize(operation.artifact.manifest, controller.signal);
        }
      }

      const definitions = new Map<ManagedPluginRecord<Reference>, AnyDefinition>();
      for (const operation of operations) {
        if (operation.kind === "update" && operation.record.status === "active") {
          definitions.set(
            operation.record,
            await this.#loadDefinition(operation.artifact, controller.signal),
          );
        }
      }

      let coreChange: PluginChangeSet | undefined;
      const getCoreChange = () => (coreChange ??= this.#container!.change());
      const handles = new Map<ManagedPluginRecord<Reference>, PluginHandle | undefined>();
      for (const operation of operations) {
        if (operation.kind === "register") {
          const handle = operation.artifact.placeholder
            ? getCoreChange().install(operation.artifact.placeholder, operation.artifact.config)
            : undefined;
          handles.set(operation.record, handle);
          continue;
        }

        const current = operation.record.coreHandle;
        if (operation.kind === "remove") {
          if (current && current.status !== "removed") getCoreChange().remove(current);
          continue;
        }

        const definition = definitions.get(operation.record);
        if (definition && current) {
          getCoreChange().update(current, {
            plugin: definition,
            config: operation.artifact.config,
          });
          handles.set(operation.record, current);
        } else if (definition) {
          handles.set(
            operation.record,
            getCoreChange().install(definition, operation.artifact.config),
          );
        } else if (current && operation.artifact.placeholder) {
          getCoreChange().update(current, {
            plugin: operation.artifact.placeholder,
            config: operation.artifact.config,
          });
          handles.set(operation.record, current);
        } else if (current) {
          if (current.status !== "removed") getCoreChange().remove(current);
          handles.set(operation.record, undefined);
        } else if (operation.artifact.placeholder) {
          handles.set(
            operation.record,
            getCoreChange().install(operation.artifact.placeholder, operation.artifact.config),
          );
        }
      }
      await coreChange?.commit();

      for (const operation of operations) {
        if (operation.kind === "remove") {
          this.#records.delete(operation.record.name);
          operation.record.removed();
          continue;
        }
        if (operation.kind === "register") {
          this.#records.set(operation.record.name, operation.record);
        }
        operation.record.replaced(
          operation.artifact,
          handles.get(operation.record),
          operation.kind === "update" && definitions.has(operation.record),
        );
      }
      this.#publish();
    } finally {
      for (const record of targets) this.#lockedRecords.delete(record);
      if (this.#changeController === controller) this.#changeController = undefined;
    }
  }

  #buildCandidate(operations: ReadonlyArray<PlatformChange<Reference>>) {
    const candidate = new Map<string, CandidatePlugin<Reference>>(
      [...this.#records.values()].map((record) => [
        record.name,
        { record, artifact: record.artifact },
      ]),
    );

    for (const operation of operations) {
      if (operation.kind === "register") {
        if (candidate.has(operation.record.name)) {
          throw new PlatformError(
            "PLUGIN_DUPLICATE",
            `Plugin '${operation.record.name}' is already registered`,
          );
        }
        candidate.set(operation.record.name, {
          record: operation.record,
          artifact: operation.artifact,
        });
      } else if (operation.kind === "update") {
        candidate.set(operation.record.name, {
          record: operation.record,
          artifact: operation.artifact,
        });
      } else {
        candidate.delete(operation.record.name);
      }
    }
    return candidate;
  }

  #validateCandidate(candidate: ReadonlyMap<string, CandidatePlugin<Reference>>) {
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

    for (const { record, artifact } of candidate.values()) {
      if (record.status !== "active") continue;
      for (const [name, range] of Object.entries(artifact.manifest.dependencies)) {
        const dependency = candidate.get(name);
        if (!dependency) {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_MISSING",
            `Active plugin '${record.name}' requires missing plugin '${name}'`,
          );
        }
        if (!matchesVersion(dependency.artifact.manifest.version, range)) {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_INCOMPATIBLE",
            `Plugin '${record.name}' requires '${name}' ${range}, found ${dependency.artifact.manifest.version}`,
          );
        }
        if (dependency.record.status !== "active") {
          throw new PlatformError(
            "PLUGIN_DEPENDENCY_INACTIVE",
            `Active plugin '${record.name}' requires inactive plugin '${name}'`,
          );
        }
      }
    }
  }

  async #activateDependencies(
    record: ManagedPluginRecord<Reference>,
    stack: ReadonlyArray<ManagedPluginRecord<Reference>>,
    signal: AbortSignal,
  ) {
    for (const [name, range] of Object.entries(record.manifest.dependencies)) {
      signal.throwIfAborted();
      const dependency = this.#records.get(name);
      if (!dependency) {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_MISSING",
          `Plugin '${record.name}' requires missing plugin '${name}'`,
        );
      }
      if (!matchesVersion(dependency.manifest.version, range)) {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_INCOMPATIBLE",
          `Plugin '${record.name}' requires '${name}' ${range}, found ${dependency.manifest.version}`,
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
      await dependency.runDependency(stack);
    }
  }

  async #loadDefinition(artifact: NormalizedArtifact<Reference>, signal: AbortSignal) {
    signal.throwIfAborted();
    let loaded: unknown;
    try {
      loaded = await this.#loader!.load(artifact.reference, signal);
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
    let definition: AnyDefinition;
    try {
      definition = definePlugin(candidate as AnyDefinition);
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
    const definition = definePlugin(placeholder as AnyDefinition);
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

  #assertManaged(record: ManagedPluginRecord<Reference>) {
    if (this.#records.get(record.name) !== record || record.status === "removed") {
      throw new PlatformError("PLUGIN_REMOVED", `Plugin '${record.name}' has been removed`);
    }
  }

  #publish() {
    this.#diagnosticModel.publish(this.#status, this.#records.values());
  }

  #enqueueChange(operation: () => Promise<void>) {
    const result = this.#changeQueue.then(operation, operation);
    this.#changeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #disposeRecords() {
    const records = [...this.#records.values()];
    for (const record of records) record.cancel();
    await Promise.all(records.map((record) => record.settled()));

    try {
      const handles = records.flatMap((record) => {
        const handle = record.coreHandle;
        return handle && handle.status !== "removed" ? [handle] : [];
      });
      if (handles.length) {
        const change = this.#container!.change();
        for (const handle of handles) change.remove(handle);
        await change.commit();
      }
      this.#records.clear();
      for (const record of records) record.removed();
      this.#status = "disposed";
      this.#publish();
      this.#diagnosticModel.close();
      this.#authority.current = undefined;
      this.#container = undefined;
      this.#loader = undefined;
      this.#permissions = undefined;
      this.#logger = undefined;
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
