import {
  asyncDisposeSymbol,
  disposeSymbol,
  isError,
  type RecordedFailure,
  type AnyPlugin,
  type ApplyResult,
  type Disposable,
  type Group,
  type Host,
  type Logger,
  type Plan,
  type SnapshotView,
} from "dougong";
import {
  batchSnapshotNotifications,
  captureDataArray,
  captureLogger,
  normalizePlainRecord,
  recordFields,
  ReadonlyMapSnapshot,
  SerialQueue,
  SnapshotPublisher,
} from "dougong/advanced";
import { captureAuthorizer, PermissionSet, type Authorizer } from "../admission/permissions.js";
import {
  artifactOrigin,
  assertCompatibleManifest,
  describeArtifact,
  type Artifact,
  type ArtifactDescriptor,
} from "../artifacts/artifact.js";
import { isConcreteVersion, isRegistrationIdPart } from "../artifacts/manifest.js";
import { ArtifactCatalog, type Catalog } from "../catalog/catalog.js";
import {
  RegistrationRecord,
  type RegistrationPort,
  type Registration,
  type RegistrationSnapshot,
} from "../catalog/registration.js";
import {
  PlatformError,
  recordPlatformFailure,
  artifactIdentityCode,
  platformBusyCode,
  platformUnavailableCode,
  registrationUnavailableCode,
  activationStaleCode,
  activationFailedCode,
} from "../errors.js";
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

const optionFields = recordFields<PlatformOptions<unknown>>()(
  "id",
  "host",
  "group",
  "apiVersion",
  "loader",
  "authorizer",
  "logger",
);
const activationOptionFields = recordFields<ActivationOptions<unknown>>()("signal", "remove");
const previewOptionFields = recordFields<ActivationPreviewOptions<unknown>>()("remove");

class DeliveryPlatform<Reference> implements Platform<Reference> {
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
  // Registration callbacks outlive disposal and must not share the constructor's loader and policy bindings.
  readonly #registrationPort: RegistrationPort<Reference> = {
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
    const admission = captureAuthorizer(
      authorizer === undefined ? new PermissionSet() : authorizer,
    );
    const capturedLogger = captureLogger(logger === undefined ? console : logger);

    this.id = id;
    this.apiVersion = apiVersion;
    const ports: PlatformPorts = Object.freeze({ host, group, authorizer: admission });
    this.#state = { phase: "active", ports };
    this.#catalog = new ArtifactCatalog(apiVersion);
    this.catalog = this.#catalog.facade;
    this.#modules = new LoadedModules({
      loader: { load: (reference, signal) => Reflect.apply(load, loader, [reference, signal]) },
      authorizer: admission,
      assertPlacement: () => this.#assertPlacement(),
    });
    this.#projection = this.#snapshot();
    this.#publisher = new SnapshotPublisher(() => this.#projection, reporter(capturedLogger));
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
          this.#supersede([registration]);
        }
      } else {
        registration = new RegistrationRecord(this.id, artifact, this.#registrationPort);
        this.#registrations.set(registration.name, registration);
        this.#handles.set(registration.facade, registration);
        this.#publish();
      }
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
    }, signal);
    try {
      const loaded = new Map<Artifact<Reference>, AnyPlugin>();
      for (const selection of operation.plan.selections) {
        operation.checkpoint();
        selection.registration.assertCurrent(selection);
        if (selection.registration.actionFor(selection.artifact) !== "reuse") {
          loaded.set(
            selection.artifact,
            await this.#whileDestinationValid(operation.signal, (signal) =>
              this.#modules.load(selection.artifact, signal),
            ),
          );
        }
      }
      return await this.#execute(operation, () =>
        this.#commitActivation(operation, roots, removing, loaded),
      );
    } catch (error) {
      operation.checkpoint();
      throw recordActivationFailure(operation.plan, error);
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
    if (this.#executing === "disposal" || this.#executing?.handedOff)
      return Promise.reject(this.#busy());
    if (state.phase === "disposing") return state.completion;
    const operations = [...this.#operations];
    const completion = Promise.all(operations.map((operation) => operation.settled)).then(() =>
      this.#execute("disposal", () => this.#release()),
    );
    this.#state = { phase: "disposing", ports: state.ports, completion };
    this.#publishBeforeCancellation(() => {
      for (const operation of operations) operation.cancel();
    });
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
    for (const root of [...roots, ...removing]) this.#assertRegistration(root);
    const plan = new ActivationPlan(this.#registrations, roots, removing);
    try {
      if (roots.length) this.#assertPlacement();
      plan.assertValid();
    } catch (error) {
      const failure = recordActivationFailure(plan, error);
      this.#publish();
      throw failure;
    }
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
    const { host, group, authorizer } = this.#ports();
    const pending = candidate.selections.filter(
      (selection) => selection.registration.actionFor(selection.artifact) !== "reuse",
    );
    const removedInstallations = ownedInstallations(removing);
    if (!pending.length && !removedInstallations.length) {
      this.#commitSelections(candidate);
      return undefined;
    }
    const change = host.change();
    for (const installation of removedInstallations) change.remove(installation);
    for (const selection of pending) {
      const plugin = loaded.get(selection.artifact);
      if (!plugin)
        throw new PlatformError(
          activationStaleCode,
          `Installation '${selection.registration.id}' changed during loading; activation must be planned again`,
        );
      const declaration = {
        configuration: selection.artifact.configuration,
        origin: artifactOrigin(this.id, selection.artifact),
      };
      const installation = selection.registration.installation;
      if (installation) change.update(installation, { plugin, ...declaration });
      else
        selection.registration.bindInstallation(
          change.install(plugin, {
            id: selection.registration.id,
            ...declaration,
            ...(group ? { group } : {}),
          }),
        );
    }
    const plan = await Preparation.waitFor((signal) => host.plan(change, signal), operation.signal);
    const admission = new Map<string, ArtifactDescriptor>(
      pending.map(({ registration, artifact }) => [registration.id, artifact]),
    );
    // A binding change can restart a committed Artifact whose selected revision was never requested.
    const preparing = new Set(plan.report.prepareOrder);
    for (const registration of this.#registrations.values()) {
      if (
        !preparing.has(registration.id) ||
        admission.has(registration.id) ||
        !registration.installation
      )
        continue;
      const origin = registration.activeOrigin;
      if (!origin)
        throw new PlatformError(
          artifactIdentityCode,
          `Cannot authorize restart of '${registration.id}' without its committed Artifact origin`,
        );
      assertCompatibleManifest(this.apiVersion, origin.manifest);
      admission.set(registration.id, origin);
    }
    await this.#whileDestinationValid(
      operation.signal,
      async (signal) => {
        for (const artifact of admission.values()) {
          await Preparation.waitFor(
            (admissionSignal) =>
              authorizer.authorize(
                Object.freeze({ artifact: describeArtifact(artifact), operation: "activate" }),
                admissionSignal,
              ),
            signal,
          );
        }
      },
      plan,
    );
    operation.plan.assertCurrent();
    operation.handoff();
    const result = await host.apply(plan);
    this.#commitSelections(candidate);
    return result;
  }

  async #whileDestinationValid<T>(
    caller: AbortSignal,
    prepare: (signal: AbortSignal) => Promise<T>,
    plan?: Plan,
  ) {
    const { host } = this.#ports();
    const expectedRevision = plan?.report.baseStateRevision;
    const invalidated = new AbortController();
    const signal = AbortSignal.any([caller, invalidated.signal]);
    const check = () => {
      const failure = this.#placementFailure();
      if (failure) {
        invalidated.abort(failure);
        return;
      }
      const stateRevision = host.stateRevision;
      if (expectedRevision !== undefined && stateRevision !== expectedRevision)
        invalidated.abort(
          new PlatformError(activationStaleCode, "Host changed during activation admission", {
            details: { outcome: "rejected", phase: "admission", expectedRevision, stateRevision },
          }),
        );
    };
    // Loading survives unrelated commits. Final admission also needs the exact revision of its Core Plan.
    const subscription = host.diagnostics.subscribe(check);
    try {
      check();
      signal.throwIfAborted();
      const result = await prepare(signal);
      signal.throwIfAborted();
      return result;
    } finally {
      subscription[disposeSymbol]();
    }
  }

  async #removeInstallations(
    registrations: ReadonlyArray<RegistrationRecord<Reference>>,
  ): Promise<ApplyResult | undefined> {
    const installations = ownedInstallations(registrations);
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

  #commitSelections(plan: ActivationPlan<Reference>) {
    for (const selection of plan.selections)
      selection.registration.clearFailure(selection.revision);
    const removed = plan.removals.map(({ registration }) => registration);
    this.#commitRemovals(removed);
    if (removed.length) this.#supersede(removed);
  }

  #commitRemovals(registrations: ReadonlyArray<RegistrationRecord<Reference>>) {
    for (const registration of registrations) {
      this.#registrations.delete(registration.name);
      registration.remove();
    }
  }

  #supersede(registrations: ReadonlyArray<RegistrationRecord<Reference>>) {
    this.#publishBeforeCancellation(() => {
      for (const registration of registrations)
        for (const operation of this.#operations) operation.supersede(registration);
    });
  }

  #publishBeforeCancellation(cancel: () => void) {
    // Abort dispatch can synchronously read both the live owner and its diagnostic projection.
    batchSnapshotNotifications(() => {
      this.#publish();
      cancel();
    });
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
        registrationUnavailableCode,
        `Registration '${registration.name}' is not selected in this Platform`,
      );
  }

  #assertPlacement() {
    const failure = this.#placementFailure();
    if (failure) throw failure;
  }

  #placementFailure() {
    const { host, group } = this.#ports();
    if (host.status === "quarantined")
      return new PlatformError(platformUnavailableCode, "Activation Host is quarantined", {
        details: { outcome: "rejected", phase: "admission", stateRevision: host.stateRevision },
      });
    if (group && host.group(group.id) !== group)
      return new PlatformError(registrationUnavailableCode, "Platform Group has been removed");
    return undefined;
  }

  #assertActive() {
    if (this.#state.phase !== "active")
      throw new PlatformError(platformUnavailableCode, `Platform is ${this.#state.phase}`);
  }

  #ports() {
    const state = this.#state;
    if (state.phase === "disposed")
      throw new PlatformError(platformUnavailableCode, "Platform is disposed");
    return state.ports;
  }

  // A callback inside planning, admission, setup or cleanup cannot await a command queued behind itself.
  #admit<T>(command: () => T, signal?: AbortSignal) {
    return this.#executing ? Promise.reject<T>(this.#busy()) : this.#queue.run(command, signal);
  }

  #busy() {
    return new PlatformError(platformBusyCode, "Platform is executing a Core command", {
      details: { outcome: "rejected" },
    });
  }

  #execute<T>(owner: ActivationOperation<Reference> | "disposal", command: () => Promise<T>) {
    return this.#queue.run(
      async () => {
        this.#executing = owner;
        try {
          this.#publish();
          return await command();
        } finally {
          this.#executing = undefined;
          this.#publish();
        }
      },
      owner === "disposal" ? undefined : owner.signal,
    );
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

function ownedInstallations<Reference>(
  registrations: ReadonlyArray<RegistrationRecord<Reference>>,
) {
  return registrations.flatMap(({ installation }) => (installation ? [installation] : []));
}

export function createPlatform<Reference>(
  options: PlatformOptions<Reference>,
): Platform<Reference> {
  return new DeliveryPlatform(options);
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

function recordActivationFailure<Reference>(plan: ActivationPlan<Reference>, error: unknown) {
  const failure = isError(error)
    ? error
    : new PlatformError(activationFailedCode, "Activation failed with a non-Error value", {
        cause: error,
      });
  let recorded: RecordedFailure | undefined;
  for (const selection of plan.selections) {
    if (selection.registration.actionFor(selection.artifact) !== "reuse") {
      selection.registration.fail(
        selection.revision,
        (recorded ??= recordPlatformFailure(failure)),
      );
    }
  }
  return failure;
}
