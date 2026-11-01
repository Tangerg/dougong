import {
  asyncDisposeSymbol,
  disposeSymbol,
  isError,
  RecordedFailure,
  type AnyPlugin,
  type ApplyResult,
  type Disposable,
  type Group,
  type Host,
  type Logger,
  type SnapshotView,
} from "dougong";
import {
  captureDataArray,
  captureLogger,
  normalizePlainRecord,
  ReadonlyMapSnapshot,
  SerialQueue,
  SnapshotPublisher,
} from "dougong/advanced";
import { PermissionSet, type Authorizer } from "../admission/permissions.js";
import { artifactOrigin, describeArtifact, type Artifact } from "../artifacts/artifact.js";
import { isConcreteVersion, isRegistrationIdPart } from "../artifacts/manifest.js";
import { ArtifactCatalog, type Catalog } from "../catalog/catalog.js";
import {
  RegistrationRecord,
  type RegistrationPort,
  type Registration,
  type RegistrationSnapshot,
} from "../catalog/registration.js";
import { PlatformError } from "../errors.js";
import type { Loader } from "../loaders/loader.js";
import { LoadedModules } from "./loading.js";
import { ActivationOperation } from "./operation.js";
import { Preparation } from "./preparation.js";
import {
  ActivationPlan,
  type ActivationOptions,
  type ActivationPreviewOptions,
  type ActivationPreview,
} from "./plan.js";

export type PlatformStatus = "active" | "disposing" | "disposed";

export interface PlatformSnapshot {
  readonly id: string;
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly registrations: ReadonlyMap<string, RegistrationSnapshot>;
}

export interface Platform<Reference> extends AsyncDisposable {
  readonly id: string;
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly catalog: Catalog<Reference>;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  registrations(): ReadonlyArray<Registration<Reference>>;
  readonly select: (artifact: Artifact<Reference>) => Promise<Registration<Reference>>;
  preview(
    registrations: ReadonlyArray<Registration<Reference>>,
    options?: ActivationPreviewOptions<Reference>,
  ): ActivationPreview;
  activate(
    registrations: ReadonlyArray<Registration<Reference>>,
    options?: ActivationOptions<Reference>,
  ): Promise<ApplyResult | undefined>;
  trigger(event: string, options?: ActivationOptions<Reference>): Promise<ApplyResult | undefined>;
  remove(
    ...registrations: ReadonlyArray<Registration<Reference>>
  ): Promise<ApplyResult | undefined>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface PlatformOptions<Reference> {
  readonly id: string;
  readonly host: Host;
  readonly group?: Group;
  readonly apiVersion: string;
  readonly loader: Loader<Reference>;
  readonly authorizer?: Authorizer;
  readonly logger?: Logger;
}

interface PlatformPorts {
  readonly host: Host;
  readonly authorizer: Authorizer;
  readonly group: Group | undefined;
}

type PlatformState =
  | { readonly phase: "active"; readonly ports: PlatformPorts }
  | {
      readonly phase: "disposing";
      readonly ports: PlatformPorts;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed" };

const optionFields = new Set([
  "id",
  "host",
  "group",
  "apiVersion",
  "loader",
  "authorizer",
  "logger",
]);
const activationOptionFields = new Set(["signal", "remove"]);
const previewOptionFields = new Set(["remove"]);

class PlatformImpl<Reference> implements Platform<Reference> {
  readonly id: string;
  readonly apiVersion: string;
  readonly catalog: Catalog<Reference>;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  readonly #catalog: ArtifactCatalog<Reference>;
  readonly #registrations = new Map<string, RegistrationRecord<Reference>>();
  readonly #handles = new WeakMap<Registration<Reference>, RegistrationRecord<Reference>>();
  readonly #queue = new SerialQueue();
  readonly #operations = new Set<ActivationOperation<Reference>>();
  readonly #modules: LoadedModules<Reference>;
  readonly #publisher: SnapshotPublisher<PlatformSnapshot>;
  readonly #registrationPort: RegistrationPort<Reference>;
  readonly #viewBinding: { synchronize: (() => void) | undefined };
  #hostSnapshot: unknown;
  #projection: PlatformSnapshot;
  #executing: ActivationOperation<Reference> | "disposal" | undefined;
  #subscription: Disposable | undefined;
  #state: PlatformState;

  constructor(options: PlatformOptions<Reference>) {
    const declaration = normalizePlainRecord(options, "Platform options", { fields: optionFields });
    const { id, host, group, apiVersion, loader, authorizer, logger } = declaration;
    if (!isRegistrationIdPart(id))
      throw new TypeError("Platform id must be a non-empty trimmed Unicode identifier");
    if (typeof apiVersion !== "string" || !isConcreteVersion(apiVersion))
      throw new TypeError("Platform apiVersion must be a semantic version");
    if (
      !host ||
      typeof host.change !== "function" ||
      typeof host.plan !== "function" ||
      typeof host.apply !== "function" ||
      typeof host.installation !== "function" ||
      !host.diagnostics
    ) {
      throw new TypeError("Platform host must implement planning, execution and inspection");
    }
    if (group !== undefined && host.group(group.id) !== group)
      throw new TypeError("Platform Group must be committed in its Host");
    const load = loader?.load;
    if (typeof load !== "function") throw new TypeError("Platform loader must implement load()");
    const policy = authorizer === undefined ? new PermissionSet() : authorizer;
    const authorize = policy?.authorize;
    if (typeof authorize !== "function")
      throw new TypeError("Platform authorizer must implement authorize()");
    const log = captureLogger(logger === undefined ? console : logger);

    this.id = id;
    this.apiVersion = apiVersion;
    const admission: Authorizer = Object.freeze({ authorize: authorize.bind(policy) });
    const ports: PlatformPorts = Object.freeze({ host, group, authorizer: admission });
    this.#state = { phase: "active", ports };
    this.#catalog = new ArtifactCatalog(apiVersion);
    this.catalog = this.#catalog.facade;
    this.#modules = new LoadedModules({
      loader: { load: load.bind(loader) },
      authorizer: admission,
      assertPlacement: () => {
        // Each shared load keeps running only while it still has a live activation waiter.
        for (const operation of this.#operations) operation.synchronizeCancellation();
        this.#assertPlacement();
      },
    });
    this.#registrationPort = {
      installation: (installationId) => this.#ports().host.installation(installationId),
      operation: (registration, revision) => {
        if (this.#executing === "disposal") return "removing";
        // The command actually driving Core takes precedence over requests still preparing.
        const executing = this.#executing?.statusFor(registration, revision);
        if (executing) return executing;
        for (const operation of this.#operations) {
          const status = operation.statusFor(registration, revision);
          if (status) return status;
        }
        return undefined;
      },
    };
    this.#projection = this.#snapshot();
    this.#publisher = new SnapshotPublisher(() => this.#projection, reporter(log));
    this.#hostSnapshot = host.diagnostics.get();
    const binding = { synchronize: (() => this.#synchronize()) as (() => void) | undefined };
    this.#viewBinding = binding;
    this.diagnostics = diagnosticView(this.#publisher.view, binding);
    this.#subscription = host.diagnostics.subscribe(() => this.#synchronize());
    Object.freeze(this);
  }

  get status() {
    return this.#state.phase;
  }

  registrations(): ReadonlyArray<Registration<Reference>> {
    return Object.freeze([...this.#registrations.values()].map((record) => record.facade));
  }

  readonly select = async (artifact: Artifact<Reference>) => {
    this.#assertActive();
    this.#catalog.assertAvailable(artifact);
    return this.#admit(() => {
      this.#assertActive();
      this.#catalog.assertAvailable(artifact);
      let registration = this.#registrations.get(artifact.manifest.name);
      if (registration) {
        if (registration.select(artifact)) {
          for (const operation of this.#operations) operation.supersede(registration);
        }
      } else {
        registration = new RegistrationRecord(this.id, artifact, this.#registrationPort);
        this.#registrations.set(registration.name, registration);
        this.#handles.set(registration.facade, registration);
      }
      this.#publish();
      return registration.facade;
    });
  };

  preview(
    registrations: ReadonlyArray<Registration<Reference>>,
    options: ActivationPreviewOptions<Reference> = {},
  ) {
    this.#assertActive();
    const declaration = normalizePlainRecord(options, "Activation preview options", {
      fields: previewOptionFields,
    });
    return new ActivationPlan(
      this.#registrations,
      this.#resolveAll(registrations),
      this.#resolveRemoval(declaration.remove),
    ).report;
  }

  async activate(
    registrations: ReadonlyArray<Registration<Reference>>,
    options: ActivationOptions<Reference> = {},
  ) {
    this.#assertActive();
    return this.#activate(this.#resolveAll(registrations), options);
  }

  async trigger(event: string, options: ActivationOptions<Reference> = {}) {
    this.#assertActive();
    if (typeof event !== "string" || !event || event.trim() !== event)
      throw new TypeError("Activation event must be a non-empty trimmed string");
    return this.#activate(event, options);
  }

  async #activate(
    target: ReadonlyArray<RegistrationRecord<Reference>> | string,
    options: ActivationOptions<Reference>,
  ) {
    const declaration = normalizePlainRecord(options, "Activation options", {
      fields: activationOptionFields,
    });
    const signal = declaration.signal;
    const removing = this.#resolveRemoval(declaration.remove);
    if (signal !== undefined) AbortSignal.prototype.throwIfAborted.call(signal);
    const { roots, operation } = await this.#admit(() => {
      // Resolve an event against the same admitted selections whose revisions the Plan captures.
      const roots =
        typeof target === "string"
          ? [...this.#registrations.values()].filter((registration) =>
              registration.selectedArtifact.manifest.activation.includes(target),
            )
          : target;
      return { roots, operation: this.#beginActivation(roots, removing, signal) };
    });
    try {
      const loaded = new Map<Artifact<Reference>, AnyPlugin>();
      for (const selection of operation.plan.selections) {
        operation.checkpoint();
        selection.registration.assertCurrent(selection);
        if (selection.registration.actionFor(selection.artifact) !== "reuse") {
          loaded.set(
            selection.artifact,
            await this.#modules.load(selection.artifact, operation.signal),
          );
        }
      }
      return await this.#execute(operation, () =>
        this.#commitActivation(operation, roots, removing, loaded),
      );
    } catch (error) {
      operation.checkpoint();
      const failure = normalizeActivationFailure(error);
      let recorded: RecordedFailure | undefined;
      for (const selection of operation.plan.selections) {
        if (selection.registration.actionFor(selection.artifact) !== "reuse") {
          selection.registration.fail(
            selection.revision,
            (recorded ??= new RecordedFailure(failure)),
          );
        }
      }
      throw failure;
    } finally {
      this.#operations.delete(operation);
      operation.finish();
      this.#publish();
    }
  }

  remove(...registrations: ReadonlyArray<Registration<Reference>>) {
    return this.activate([], { remove: registrations });
  }

  #startDisposal() {
    const state = this.#state;
    if (state.phase === "disposed") return Promise.resolve();
    if (this.#executing) return Promise.reject(this.#busy());
    if (state.phase === "disposing") return state.completion;
    const operations = [...this.#operations];
    const completion = Promise.all(operations.map((operation) => operation.settled)).then(() =>
      this.#execute("disposal", () => this.#release()),
    );
    this.#state = { phase: "disposing", ports: state.ports, completion };
    for (const operation of operations) operation.cancel();
    this.#publish();
    return completion;
  }

  [asyncDisposeSymbol]() {
    return this.#startDisposal();
  }

  #beginActivation(
    roots: ReadonlyArray<RegistrationRecord<Reference>>,
    removing: ReadonlyArray<RegistrationRecord<Reference>>,
    signal: AbortSignal | undefined,
  ) {
    this.#assertActive();
    if (roots.length) this.#assertPlacement();
    for (const root of [...roots, ...removing]) this.#assertRegistration(root);
    const plan = new ActivationPlan(this.#registrations, roots, removing);
    plan.assertValid();
    const operation = new ActivationOperation(plan, signal);
    this.#operations.add(operation);
    this.#publish();
    return operation;
  }

  async #commitActivation(
    operation: ActivationOperation<Reference>,
    roots: ReadonlyArray<RegistrationRecord<Reference>>,
    removing: ReadonlyArray<RegistrationRecord<Reference>>,
    loaded: ReadonlyMap<Artifact<Reference>, AnyPlugin>,
  ): Promise<ApplyResult | undefined> {
    this.#assertActive();
    if (roots.length) this.#assertPlacement();
    operation.checkpoint();
    operation.plan.assertCurrent();
    const candidate = new ActivationPlan(this.#registrations, roots, removing);
    candidate.assertValid();
    const { host, authorizer, group } = this.#ports();
    const pending = candidate.selections.filter(
      (selection) => selection.registration.actionFor(selection.artifact) !== "reuse",
    );
    const removedInstallations = removing.flatMap((registration) =>
      registration.installation ? [registration.installation] : [],
    );
    if (!pending.length && !removedInstallations.length) {
      this.#commitRemovals(removing);
      for (const selection of candidate.selections)
        selection.registration.clearFailure(selection.revision);
      return undefined;
    }
    const change = host.change();
    for (const installation of removedInstallations) change.remove(installation);
    for (const selection of pending) {
      const plugin = loaded.get(selection.artifact);
      if (!plugin)
        throw new PlatformError(
          "ACTIVATION_STALE",
          `Installation '${selection.registration.id}' changed during loading; activation must be planned again`,
        );
      const options = {
        plugin,
        config: selection.artifact.config,
        origin: artifactOrigin(this.id, selection.artifact),
      };
      const installation = selection.registration.installation;
      if (installation) change.update(installation, options);
      else
        selection.registration.bindInstallation(
          change.install(plugin, {
            id: selection.registration.id,
            config: selection.artifact.config,
            origin: options.origin,
            ...(group ? { group } : {}),
          }),
        );
    }
    const plan = await Preparation.waitFor(() => host.plan(change), operation.signal);
    for (const selection of pending) {
      operation.checkpoint();
      await Preparation.waitFor(
        (signal) =>
          authorizer.authorize(
            Object.freeze({
              artifact: describeArtifact(selection.artifact),
              operation: "activate",
            }),
            signal,
          ),
        operation.signal,
      );
    }
    operation.plan.assertCurrent();
    operation.handoff();
    const result = await host.apply(plan);
    this.#commitRemovals(removing);
    for (const selection of candidate.selections)
      selection.registration.clearFailure(selection.revision);
    return result;
  }

  async #removeInstallations(
    registrations: ReadonlyArray<RegistrationRecord<Reference>>,
  ): Promise<ApplyResult | undefined> {
    const installations = registrations.flatMap((registration) =>
      registration.installation ? [registration.installation] : [],
    );
    if (!installations.length) return undefined;
    const host = this.#ports().host;
    const change = host.change();
    for (const installation of installations) change.remove(installation);
    return host.apply(await host.plan(change));
  }

  async #release() {
    const ports = this.#ports();
    const registrations = [...this.#registrations.values()];
    try {
      await this.#removeInstallations(registrations);
    } catch (error) {
      this.#state = { phase: "active", ports };
      this.#publish();
      throw error;
    }
    this.#commitRemovals(registrations);
    this.#modules.close();
    this.#catalog.close();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    this.#state = { phase: "disposed" };
    this.#viewBinding.synchronize = undefined;
    this.#hostSnapshot = undefined;
    try {
      subscription?.[disposeSymbol]();
    } finally {
      this.#publish();
      this.#publisher[disposeSymbol]();
    }
  }

  #commitRemovals(registrations: ReadonlyArray<RegistrationRecord<Reference>>) {
    for (const registration of registrations) {
      this.#registrations.delete(registration.name);
      registration.remove();
      for (const operation of this.#operations) operation.supersede(registration);
    }
  }

  #resolveRemoval(registrations: ReadonlyArray<Registration<Reference>> | undefined) {
    if (registrations === undefined) return [];
    return this.#resolveAll(registrations, "Removed registrations");
  }

  #resolveAll(
    registrations: ReadonlyArray<Registration<Reference>>,
    label = "Activation registrations",
  ) {
    // Calling a method supplied by the input could hand its owner the internal record returned by this callback.
    const resolved = captureDataArray(registrations, label).map((registration) => {
      const record =
        registration && typeof registration === "object"
          ? this.#handles.get(registration)
          : undefined;
      if (!record) throw new TypeError("Registration belongs to a different Platform");
      this.#assertRegistration(record);
      return record;
    });
    return [...new Set(resolved)];
  }

  #assertRegistration(registration: RegistrationRecord<Reference>) {
    if (this.#registrations.get(registration.name) !== registration)
      throw new PlatformError(
        "REGISTRATION_UNAVAILABLE",
        `Registration '${registration.name}' is not selected in this Platform`,
      );
  }

  #assertPlacement() {
    const { host, group } = this.#ports();
    if (host.status === "quarantined")
      throw new PlatformError("PLATFORM_UNAVAILABLE", "Activation Host is quarantined", {
        details: { outcome: "rejected", phase: "admission", stateRevision: host.stateRevision },
      });
    if (group && host.group(group.id) !== group)
      throw new PlatformError("REGISTRATION_UNAVAILABLE", "Platform Group has been removed");
  }

  #assertActive() {
    if (this.#state.phase !== "active")
      throw new PlatformError("PLATFORM_UNAVAILABLE", `Platform is ${this.#state.phase}`);
  }

  #ports() {
    const state = this.#state;
    if (state.phase === "disposed")
      throw new PlatformError("PLATFORM_UNAVAILABLE", "Platform is disposed");
    return state.ports;
  }

  // A callback inside planning, admission, setup or cleanup cannot await a command queued behind itself.
  #admit<T>(command: () => T) {
    return this.#executing ? Promise.reject<T>(this.#busy()) : this.#queue.run(command);
  }

  #busy() {
    return new PlatformError("PLATFORM_BUSY", "Platform is executing a Core command", {
      details: { outcome: "rejected" },
    });
  }

  #execute<T>(owner: ActivationOperation<Reference> | "disposal", command: () => Promise<T>) {
    return this.#queue.run(async () => {
      this.#executing = owner;
      try {
        this.#publish();
        return await command();
      } finally {
        this.#executing = undefined;
        this.#publish();
      }
    });
  }

  #publish() {
    if (this.#state.phase !== "disposed") this.#hostSnapshot = this.#ports().host.diagnostics.get();
    const projection = this.#snapshot(this.#projection);
    if (projection === this.#projection) return;
    this.#projection = projection;
    this.#publisher.invalidate();
  }

  #synchronize() {
    if (
      this.#state.phase !== "disposed" &&
      this.#ports().host.diagnostics.get() !== this.#hostSnapshot
    )
      this.#publish();
  }

  #snapshot(previous?: PlatformSnapshot): PlatformSnapshot {
    let changed =
      previous?.status !== this.status || previous.registrations.size !== this.#registrations.size;
    const entries = [...this.#registrations].map(([name, registration]) => {
      const before = previous?.registrations.get(name);
      const next = registration.snapshot(before);
      if (before !== next) changed = true;
      return [name, next] as const;
    });
    if (!changed && previous) return previous;
    return Object.freeze({
      id: this.id,
      apiVersion: this.apiVersion,
      status: this.status,
      registrations: new ReadonlyMapSnapshot(entries),
    });
  }
}

export function createPlatform<Reference>(
  options: PlatformOptions<Reference>,
): Platform<Reference> {
  return new PlatformImpl(options);
}

// A retained view must not capture its owner's constructor scope after the binding is detached.
function diagnosticView<T>(
  view: SnapshotView<T>,
  binding: { synchronize: (() => void) | undefined },
): SnapshotView<T> {
  return Object.freeze({
    get: () => {
      binding.synchronize?.();
      return view.get();
    },
    subscribe: view.subscribe,
  });
}

function reporter(logger: Logger) {
  return (error: unknown) => {
    try {
      // The terminal sink has no lower reporter, but its rejection must still be observed.
      void Promise.resolve(logger.error(error)).catch(() => undefined);
    } catch {
      // Observer failures must not change the outcome of a committed operation.
    }
  };
}

function normalizeActivationFailure(error: unknown) {
  return isError(error)
    ? error
    : new PlatformError("ACTIVATION_FAILED", "Activation failed with a non-Error value", {
        cause: error,
      });
}
