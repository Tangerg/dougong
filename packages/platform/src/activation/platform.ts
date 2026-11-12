import {
  asyncDisposeSymbol,
  disposeSymbol,
  isCancellationReason,
  type AnyPlugin,
  type ApplyResult,
  type Group,
  type Host,
  type HostSnapshot,
  type Plan,
  type SnapshotView,
} from "dougong";
import {
  batchSnapshotNotifications,
  captureDataArray,
  normalizePlainRecord,
  recordFields,
  resolveValue,
  SerialQueue,
  SnapshotPublisher,
} from "dougong/advanced";
import type { Authorizer } from "../admission/permissions.js";
import {
  artifactOrigin,
  assertCompatibleManifest,
  describeArtifact,
  type Artifact,
  type ArtifactDescriptor,
} from "../artifacts/artifact.js";
import { isTrimmedText } from "../artifacts/manifest.js";
import { ArtifactCatalog, type Catalog } from "../catalog/catalog.js";
import {
  RegistrationRecord,
  type RegistrationPort,
  type Registration,
} from "../catalog/registration.js";
import {
  PlatformError,
  artifactIdentityCode,
  platformBusyCode,
  platformUnavailableCode,
  registrationUnavailableCode,
  activationStaleCode,
} from "../errors.js";
import { recordActivationFailure } from "./activation-failure.js";
import { LoadedModules } from "./loading.js";
import { HostObservation } from "./host-observation.js";
import { ActivationOperation } from "./operation.js";
import { Preparation } from "./preparation.js";
import {
  ActivationPlan,
  type ActivationOptions,
  type ActivationPreviewOptions,
  type ActivationPreview,
} from "./plan.js";
import {
  diagnosticView,
  projectPlatformSnapshot,
  terminalReporter,
  type PlatformSnapshot,
  type PlatformStatus,
} from "./platform-diagnostics.js";
import { capturePlatformOptions, type PlatformOptions } from "./platform-options.js";

export interface Platform<Reference> extends AsyncDisposable {
  readonly id: string;
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly catalog: Catalog<Reference>;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  registrations(): ReadonlyArray<Registration<Reference>>;
  readonly select: <const Artifacts extends ReadonlyArray<Artifact<Reference>>>(
    artifacts: Artifacts,
  ) => Promise<{ readonly [Index in keyof Artifacts]: Registration<Reference> }>;
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

interface PlatformPorts {
  readonly host: Host;
  readonly authorizer: Authorizer;
  readonly group: Group | undefined;
  readonly reportNotificationFailure: (error: unknown) => void;
}

type PlatformState =
  | { readonly phase: "active"; readonly ports: PlatformPorts }
  | {
      readonly phase: "disposing";
      readonly ports: PlatformPorts;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed"; readonly completion: Promise<void> };

// The one command driving Core; callbacks inside it cannot queue another command behind it.
type CoreCommand<Reference> =
  | { readonly kind: "activation"; readonly operation: ActivationOperation<Reference> }
  | { readonly kind: "disposal" };

const disposalCommand = Object.freeze({ kind: "disposal" } as const);

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
      const command = this.#executing;
      if (command?.kind === "disposal") return "removing";
      // The command actually driving Core takes precedence over requests still preparing.
      const executing = command?.operation.statusFor(registration, revision);
      if (executing) return executing;
      for (const operation of this.#operations) {
        const status = operation.statusFor(registration, revision);
        if (status) return status;
      }
      return undefined;
    },
  };
  readonly #hostObservation: HostObservation;
  #hostSnapshot: HostSnapshot | undefined;
  #projection: PlatformSnapshot;
  #executing: CoreCommand<Reference> | undefined;
  #state: PlatformState;

  constructor(options: PlatformOptions<Reference>) {
    const { id, apiVersion, host, group, loader, authorizer, logger } =
      capturePlatformOptions(options);
    this.id = id;
    this.apiVersion = apiVersion;
    const ports: PlatformPorts = Object.freeze({
      host,
      group,
      authorizer,
      reportNotificationFailure: terminalReporter(logger),
    });
    this.#state = { phase: "active", ports };
    this.#catalog = new ArtifactCatalog(apiVersion);
    this.catalog = this.#catalog.facade;
    this.#modules = new LoadedModules({
      loader,
      authorizer,
      assertPlacement: () => this.#assertPlacement(),
    });
    this.#hostSnapshot = host.diagnostics.get();
    this.#projection = this.#snapshot();
    this.#publisher = new SnapshotPublisher(
      () => (this.#projection = this.#snapshot(this.#projection)),
      ports.reportNotificationFailure,
    );
    this.#hostObservation = new HostObservation(host.diagnostics, this.#synchronize.bind(this));
    this.diagnostics = diagnosticView(this.#publisher.view, this.#hostObservation);
    Object.freeze(this);
  }

  get status() {
    return this.#state.phase;
  }

  registrations(): ReadonlyArray<Registration<Reference>> {
    return Object.freeze([...this.#registrations.values()].map((record) => record.facade));
  }

  readonly select: Platform<Reference>["select"] = async (artifacts) => {
    this.#assertActive();
    const captured = captureDataArray(artifacts, "Selection artifacts");
    this.#assertSelectable(captured);
    return this.#admit(() => {
      this.#assertActive();
      this.#assertSelectable(captured);
      const changed: RegistrationRecord<Reference>[] = [];
      const selected = captured.map((artifact) => {
        let registration = this.#registrations.get(artifact.manifest.name);
        if (registration) {
          if (registration.select(artifact)) changed.push(registration);
        } else {
          registration = new RegistrationRecord(this.id, artifact, this.#registrationPort);
          this.#registrations.set(registration.name, registration);
          this.#handles.set(registration.facade, registration);
          changed.push(registration);
        }
        return registration.facade;
      });
      if (changed.length) this.#supersede(changed);
      return Object.freeze(selected) as {
        readonly [Index in keyof typeof artifacts]: Registration<Reference>;
      };
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
    if (!isTrimmedText(event))
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
    let admittedOperation: ActivationOperation<Reference> | undefined;
    try {
      const { roots, operation } = await this.#admit(() => {
        // Resolve an event against the same admitted selections whose revisions the Plan captures.
        const roots =
          typeof target === "string"
            ? [...this.#registrations.values()].filter((registration) =>
                registration.selectedArtifact.manifest.activation.includes(target),
              )
            : target;
        admittedOperation = this.#beginActivation(roots, removing, signal);
        return { roots, operation: admittedOperation };
      }, signal);
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
      return await this.#execute({ kind: "activation", operation }, () =>
        this.#commitActivation(operation, roots, removing, loaded),
      );
    } catch (error) {
      if (!admittedOperation) throw error;
      // A cancellation request cannot replace an independently settled failure.
      if (isCancellationReason(admittedOperation.signal, error)) throw error;
      throw recordActivationFailure(admittedOperation.plan, error);
    } finally {
      if (admittedOperation) this.#finishActivation(admittedOperation);
    }
  }

  remove(...registrations: ReadonlyArray<Registration<Reference>>) {
    return this.activate([], { remove: registrations });
  }

  #startDisposal() {
    const state = this.#state;
    if (state.phase === "disposed") return state.completion;
    const command = this.#executing;
    if (command?.kind === "disposal" || command?.operation.handedOff)
      return Promise.reject(this.#busy());
    if (state.phase === "disposing") return state.completion;
    const operations = [...this.#operations];
    const completion: Promise<void> = Promise.all(
      operations.map((operation) => operation.settled),
    ).then(() => this.#execute(disposalCommand, () => this.#release(completion)));
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
    this.#assertActive();
    const operation = new ActivationOperation(plan);
    this.#operations.add(operation);
    try {
      // Disposal must own the operation before notification or cancellation attachment can reenter it.
      this.#publish();
      operation.admit(signal);
      return operation;
    } catch (error) {
      this.#finishActivation(operation);
      throw error;
    }
  }

  #finishActivation(operation: ActivationOperation<Reference>) {
    this.#operations.delete(operation);
    operation.finish();
    this.#publish();
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
    const { value: plan } = await Preparation.waitFor(
      (signal) => host.plan(change, signal),
      operation.signal,
    );
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
    const { value: result } = await resolveValue(host.apply(plan, operation.signal));
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
    const observation = new HostObservation(host.diagnostics, check);
    let outcome:
      | { readonly status: "fulfilled"; readonly value: T }
      | { readonly status: "rejected"; readonly reason: unknown };
    try {
      check();
      signal.throwIfAborted();
      const result = await prepare(signal);
      signal.throwIfAborted();
      outcome = { status: "fulfilled", value: result };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
    try {
      observation.close();
    } catch (error) {
      if (outcome.status === "rejected")
        throw new AggregateError(
          [outcome.reason, error],
          "Activation preparation and diagnostic withdrawal failed",
        );
      throw error;
    }
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }

  async #removeInstallations(
    registrations: ReadonlyArray<RegistrationRecord<Reference>>,
  ): Promise<ApplyResult | undefined> {
    const installations = ownedInstallations(registrations);
    if (!installations.length) return undefined;
    const host = this.#ports().host;
    const change = host.change();
    for (const installation of installations) change.remove(installation);
    const { value: plan } = await resolveValue(host.plan(change));
    return (await resolveValue(host.apply(plan))).value;
  }

  async #release(completion: Promise<void>) {
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
    this.#state = { phase: "disposed", completion };
    this.#hostSnapshot = undefined;
    try {
      batchSnapshotNotifications(() => {
        // Foreign withdrawal can synchronously read both the boundary and its snapshot.
        this.#publisher.invalidate();
        this.#hostObservation.close();
      }, ports.reportNotificationFailure);
    } finally {
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
    }, this.#ports().reportNotificationFailure);
  }

  #resolveRemoval(registrations: ReadonlyArray<Registration<Reference>> | undefined) {
    if (registrations === undefined) return [];
    return this.#resolveAll(registrations, "Removed registrations");
  }

  #assertSelectable(artifacts: ReadonlyArray<Artifact<Reference>>) {
    const names = new Set<string>();
    for (const artifact of artifacts) {
      this.#catalog.assertAvailable(artifact);
      const name = artifact.manifest.name;
      if (names.has(name)) throw new TypeError(`Duplicate selected Registration '${name}'`);
      names.add(name);
    }
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
    return this.#executing
      ? Promise.reject<Awaited<T>>(this.#busy())
      : this.#queue.run(command, signal).then(({ value }) => value);
  }

  #busy() {
    return new PlatformError(platformBusyCode, "Platform is executing a Core command", {
      details: { outcome: "rejected" },
    });
  }

  #execute<T>(command: CoreCommand<Reference>, run: () => Promise<T>) {
    return this.#queue
      .run(
        async () => {
          this.#executing = command;
          try {
            this.#publish();
            return await run();
          } finally {
            this.#executing = undefined;
            this.#publish();
          }
        },
        command.kind === "activation" ? command.operation.signal : undefined,
      )
      .then(({ value }) => value);
  }

  #publish() {
    if (this.#state.phase === "disposed") return;
    const ports = this.#ports();
    // Diagnostic failures must not interrupt the command's cancellation or settlement.
    batchSnapshotNotifications(() => this.#publisher.invalidate(), ports.reportNotificationFailure);
  }

  #synchronize() {
    if (this.#state.phase === "disposed") return;
    const snapshot = this.#ports().host.diagnostics.get();
    if (snapshot === this.#hostSnapshot) return;
    this.#hostSnapshot = snapshot;
    this.#publish();
  }

  #snapshot(previous?: PlatformSnapshot): PlatformSnapshot {
    return projectPlatformSnapshot(
      {
        id: this.id,
        apiVersion: this.apiVersion,
        status: this.status,
        registrations: this.#registrations,
        hostSnapshot: this.#hostSnapshot,
      },
      previous,
    );
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
