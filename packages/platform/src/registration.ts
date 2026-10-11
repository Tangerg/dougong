import {
  isError,
  RecordedFailure,
  SerialQueue,
  type Disposable,
  type Installation,
} from "@dougongjs/core";
import type { Registration, NormalizedArtifact, PlatformChangeSet, Artifact } from "./platform-api";
import { PlatformError } from "./errors";
import type { ActivationPermit } from "./activation-gate";

export interface RegistrationPort<Reference> {
  readonly change: () => PlatformChangeSet<Reference>;
  readonly settled: () => Promise<void>;
  readonly notifyChanged: () => void;
  readonly activateRegistration: (
    registration: RegistrationRecord<Reference>,
    signal: AbortSignal,
    permit?: ActivationPermit,
  ) => Promise<void>;
}

type RegistrationAuthority<Reference> =
  | { readonly phase: "draft"; artifact: NormalizedArtifact<Reference> }
  | {
      readonly phase: "granted";
      readonly port: RegistrationPort<Reference>;
      artifact: NormalizedArtifact<Reference>;
      admission: Promise<void> | undefined;
    }
  | { readonly phase: "terminal"; readonly manifest: NormalizedArtifact<Reference>["manifest"] };

type RegistrationState =
  | { readonly phase: "pending" }
  | { readonly phase: "registered"; readonly installation: Installation | undefined }
  | { readonly phase: "loading"; readonly installation: Installation | undefined }
  | { readonly phase: "loaded"; readonly installation: Installation }
  | {
      readonly phase: "failed";
      readonly installation: Installation | undefined;
      readonly error: Error;
    }
  | { readonly phase: "removed" };

export type RegistrationCommitState = Extract<
  RegistrationState,
  { readonly phase: "registered" | "loaded" }
>;

class RegistrationFacade<Reference> implements Registration<Reference> {
  readonly #registration: RegistrationRecord<Reference>;

  constructor(registration: RegistrationRecord<Reference>) {
    this.#registration = registration;
    Object.freeze(this);
  }

  get manifest() {
    return this.#registration.manifest;
  }

  get status() {
    return this.#registration.status;
  }

  ready() {
    return this.#registration.ready();
  }

  activate() {
    return this.#registration.activate();
  }

  update(artifact: Artifact<Reference>) {
    return this.#registration.update(artifact);
  }

  remove() {
    return this.#registration.remove();
  }
}

// Authority and delivery state are independent: a failed Registration can remain authorized and retryable.
export class RegistrationRecord<Reference> {
  #authority: RegistrationAuthority<Reference>;
  #state: RegistrationState = { phase: "pending" };
  #installationSubscription: Disposable | undefined;
  readonly #activationQueue = new SerialQueue();
  #activationController: AbortController | undefined;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly facade: Registration<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#authority = { phase: "draft", artifact };
    this.facade = new RegistrationFacade(this);
  }

  attach(port: RegistrationPort<Reference>) {
    const authority = this.#authority;
    if (authority.phase !== "draft") {
      throw new Error(`Registration '${this.manifestName}' is already sealed`);
    }
    this.#authority = {
      phase: "granted",
      port,
      artifact: authority.artifact,
      admission: undefined,
    };
  }

  get manifestName() {
    return this.manifest.name;
  }

  get manifest() {
    const authority = this.#authority;
    return authority.phase === "terminal" ? authority.manifest : authority.artifact.manifest;
  }

  get artifact() {
    const authority = this.#authority;
    if (authority.phase === "terminal") throw this.unavailableError();
    return authority.artifact;
  }

  get status() {
    if (this.installation?.status === "removed") return "unavailable";
    return this.#state.phase === "loaded" ? "installed" : this.#state.phase;
  }

  assertInstallable() {
    if (this.status === "unavailable") throw this.unavailableError();
  }

  get hasAuthority() {
    return this.#authority.phase === "granted";
  }

  get error() {
    if (this.status === "unavailable") {
      return new PlatformError(
        "REGISTRATION_UNAVAILABLE",
        `Registration '${this.manifestName}' lost its Core Installation`,
      );
    }
    const state = this.#state;
    if (state.phase === "failed") {
      return state.error;
    }
    if (state.phase === "removed") {
      return new PlatformError(
        "REGISTRATION_REMOVED",
        `Registration '${this.manifestName}' has been removed`,
      );
    }
    return undefined;
  }

  get installation() {
    const state = this.#state;
    return "installation" in state ? state.installation : undefined;
  }

  ready() {
    const boundary = this.#grantedAuthority()?.port.settled();
    return boundary
      ? boundary.then(() => this.#readyFromCurrentState())
      : this.#readyFromCurrentState();
  }

  #readyFromCurrentState() {
    if (this.status === "unavailable") return Promise.reject(this.unavailableError());
    const state = this.#state;
    if (state.phase === "loaded") {
      return state.installation.ready();
    }
    if (state.phase === "failed" || state.phase === "removed") {
      return Promise.reject(
        this.error ??
          new PlatformError(
            "REGISTRATION_UNAVAILABLE",
            `Registration '${this.manifestName}' is unavailable`,
          ),
      );
    }
    const completion = Promise.withResolvers<void>();
    this.#readyWaiters.add(completion);
    return completion.promise;
  }

  activate() {
    const authority = this.#grantedAuthority();
    if (!authority) return Promise.reject(this.unavailableError());
    const { port, admission } = authority;
    return this.#enqueueActivation(async (signal) => {
      if (admission) await admission;
      signal.throwIfAborted();
      await port.activateRegistration(this, signal);
    });
  }

  async update(artifact: Artifact<Reference>): Promise<void> {
    const authority = this.#grantedAuthority();
    if (!authority) throw this.unavailableError();
    const change = authority.port.change();
    change.update(this.facade, artifact);
    await change.commit();
  }

  async remove(): Promise<void> {
    const authority = this.#grantedAuthority();
    if (!authority) {
      if (this.#state.phase === "removed" || this.#state.phase === "failed") return;
      throw this.unavailableError();
    }
    const change = authority.port.change();
    change.remove(this.facade);
    await change.commit();
  }

  activateAsDependency(permit: ActivationPermit) {
    const authority = this.#grantedAuthority();
    if (!authority) return Promise.reject(this.unavailableError());
    return this.#enqueueActivation((signal) =>
      authority.port.activateRegistration(this, signal, permit),
    );
  }

  beginActivation() {
    this.#state = { phase: "loading", installation: this.installation };
  }

  trackAdmission(operation: Promise<void>) {
    const authority = this.#authority;
    if (authority.phase !== "granted") {
      throw new Error(`Registration '${this.manifestName}' has no admission authority`);
    }
    authority.admission = operation;
  }

  commitActivation(installation: Installation) {
    this.#state = { phase: "loaded", installation };
    this.#observeInstallation();
    this.assertInstallable();
    // Forward readiness to Core because creating an Installation does not prove its Plugin has started.
    for (const waiter of this.#readyWaiters) {
      void installation.ready().then(waiter.resolve, waiter.reject);
    }
    this.#readyWaiters.clear();
  }

  // Prepare fallible validation before Core commits so applying Registration state cannot fail afterward.
  prepareCommit(artifact: NormalizedArtifact<Reference>, state: RegistrationCommitState) {
    const authority = this.#authority;
    if (authority.phase !== "granted") throw this.unavailableError();
    return () => {
      authority.admission = undefined;
      authority.artifact = artifact;
      this.#state = state;
      this.#observeInstallation();
    };
  }

  fail(error: unknown) {
    const failure = normalizeRegistrationFailure(error, this.manifestName);
    this.#state = {
      phase: "failed",
      installation: this.installation,
      error: failure,
    };
    this.#clearAdmission();
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    return failure;
  }

  discard(error: unknown) {
    const failure = new RecordedFailure(normalizeRegistrationFailure(error, this.manifestName));
    this.#state = { phase: "failed", installation: undefined, error: failure };
    this.#installationSubscription?.dispose();
    this.#installationSubscription = undefined;
    this.#authority = { phase: "terminal", manifest: this.manifest };
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
  }

  markRemoved() {
    const error = new PlatformError(
      "REGISTRATION_REMOVED",
      `Registration '${this.manifestName}' has been removed`,
    );
    this.#installationSubscription?.dispose();
    this.#installationSubscription = undefined;
    this.#authority = { phase: "terminal", manifest: this.manifest };
    this.#state = { phase: "removed" };
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  cancelActivation() {
    this.#activationController?.abort();
  }

  whenActivationSettled() {
    return this.#activationQueue.settled;
  }

  #observeInstallation() {
    this.#installationSubscription?.dispose();
    this.#installationSubscription = undefined;
    const installation = this.installation;
    const authority = this.#grantedAuthority();
    const rejectUnavailable = () => {
      if (this.status !== "unavailable") return;
      const error = this.unavailableError();
      for (const waiter of this.#readyWaiters) waiter.reject(error);
      this.#readyWaiters.clear();
    };
    rejectUnavailable();
    if (!installation || installation.status === "removed" || !authority) return;
    this.#installationSubscription = installation.diagnostics.subscribe(() => {
      // Classify bindings after structural settlement because Core can remove a placeholder before Platform commits.
      void authority.port.settled().then(() => {
        rejectUnavailable();
        authority.port.notifyChanged();
      });
    });
  }

  #grantedAuthority() {
    const authority = this.#authority;
    return authority.phase === "granted" ? authority : undefined;
  }

  #clearAdmission() {
    const authority = this.#authority;
    if (authority.phase === "granted") authority.admission = undefined;
  }

  #enqueueActivation(operation: (signal: AbortSignal) => Promise<void>) {
    const run = async () => {
      const controller = new AbortController();
      this.#activationController = controller;
      try {
        await operation(controller.signal);
      } finally {
        if (this.#activationController === controller) this.#activationController = undefined;
      }
    };
    return this.#activationQueue.run(run);
  }

  unavailableError() {
    return (
      this.error ??
      new PlatformError(
        "REGISTRATION_UNAVAILABLE",
        `Registration '${this.manifestName}' has not been committed`,
      )
    );
  }
}

export function normalizeRegistrationFailure(error: unknown, manifestName: string): Error {
  if (isError(error)) return error;
  return new PlatformError(
    "REGISTRATION_UNAVAILABLE",
    `Registration '${manifestName}' failed with a non-Error value`,
    { cause: error },
  );
}

export function assertCurrentRegistration<Reference>(
  registrations: ReadonlyMap<string, RegistrationRecord<Reference>>,
  registration: RegistrationRecord<Reference>,
) {
  if (
    registrations.get(registration.manifestName) !== registration ||
    registration.status === "removed"
  ) {
    throw registration.unavailableError();
  }
}
