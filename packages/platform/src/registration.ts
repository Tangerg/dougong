import {
  DougongError,
  SerialQueue,
  type Installation,
  type Provisions,
  type Requirements,
} from "@dougongjs/core";
import type { Registration, NormalizedArtifact, PlatformChangeSet, Artifact } from "./platform-api";
import { PlatformError } from "./errors";
import type { ActivationPermit } from "./activation-gate";

export interface RegistrationPort<Reference> {
  change(): PlatformChangeSet<Reference>;
  activateRegistration(
    registration: RegistrationRecord<Reference>,
    signal: AbortSignal,
    permit?: ActivationPermit,
  ): Promise<void>;
}

type RegistrationAuthority<Reference> =
  | { readonly phase: "draft"; artifact: NormalizedArtifact<Reference> }
  | {
      readonly phase: "attached";
      readonly port: RegistrationPort<Reference>;
      artifact: NormalizedArtifact<Reference>;
      admission: Promise<void> | undefined;
    }
  | { readonly phase: "terminal" };

type TerminalRegistrationFailure =
  | {
      readonly category: "coded";
      readonly name: string;
      readonly message: string;
      readonly code: string;
      readonly domain: "core" | "platform";
    }
  | {
      readonly category: "typeError" | "error";
      readonly name: string;
      readonly message: string;
    };

type RegistrationFailure =
  | { readonly retention: "live"; readonly error: Error }
  | { readonly retention: "summary"; readonly summary: TerminalRegistrationFailure };

type RegistrationState =
  | { readonly phase: "pending" }
  | { readonly phase: "registered"; readonly installation: Installation | undefined }
  | { readonly phase: "loading"; readonly installation: Installation | undefined }
  | { readonly phase: "activated"; readonly installation: Installation }
  | {
      readonly phase: "failed";
      readonly installation: Installation | undefined;
      readonly failure: RegistrationFailure;
    }
  | { readonly phase: "removed" };

export type RegistrationCommitState = Extract<
  RegistrationState,
  { readonly phase: "registered" | "activated" }
>;

class RegistrationImpl<Reference> implements Registration<Reference> {
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

  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>) {
    return this.#registration.update(artifact);
  }

  remove() {
    return this.#registration.remove();
  }
}

/** Internal state machine behind one public Registration. */
export class RegistrationRecord<Reference> {
  #authority: RegistrationAuthority<Reference>;
  #manifest: NormalizedArtifact<Reference>["manifest"];
  #state: RegistrationState = { phase: "pending" };
  readonly #activationQueue = new SerialQueue();
  #activationController: AbortController | undefined;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly publicRegistration: Registration<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#authority = { phase: "draft", artifact };
    this.#manifest = artifact.manifest;
    this.publicRegistration = new RegistrationImpl(this);
  }

  attach(port: RegistrationPort<Reference>) {
    const authority = this.#authority;
    if (authority.phase !== "draft") {
      throw new Error(`Registration '${this.manifestName}' is already sealed`);
    }
    this.#authority = {
      phase: "attached",
      port,
      artifact: authority.artifact,
      admission: undefined,
    };
  }

  get manifestName() {
    return this.#manifest.name;
  }

  get manifest() {
    return this.#manifest;
  }

  get artifact() {
    const authority = this.#authority;
    if (authority.phase === "terminal") throw this.unavailableError();
    return authority.artifact;
  }

  get status() {
    return this.#state.phase;
  }

  /** Whether the owning ChangeSet has granted this Registration Platform authority. */
  get attached() {
    return this.#authority.phase === "attached";
  }

  get error() {
    const state = this.#state;
    if (state.phase === "failed") {
      return state.failure.retention === "live"
        ? state.failure.error
        : restoreFailure(state.failure.summary);
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
    const state = this.#state;
    if (state.phase === "activated") {
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
    const authority = this.#attachedAuthority();
    if (!authority) return Promise.reject(this.unavailableError());
    const { port, admission } = authority;
    return this.#enqueueActivation(async (signal) => {
      if (admission) await admission;
      signal.throwIfAborted();
      await port.activateRegistration(this, signal);
    });
  }

  async update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>): Promise<void> {
    const authority = this.#attachedAuthority();
    if (!authority) throw this.unavailableError();
    await authority.port.change().update(this.publicRegistration, artifact).commit();
  }

  async remove(): Promise<void> {
    const authority = this.#attachedAuthority();
    if (!authority) {
      if (this.#state.phase === "removed" || this.#state.phase === "failed") return;
      throw this.unavailableError();
    }
    await authority.port.change().remove(this.publicRegistration).commit();
  }

  activateAsDependency(permit: ActivationPermit) {
    const authority = this.#attachedAuthority();
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
    if (authority.phase !== "attached") {
      throw new Error(`Registration '${this.manifestName}' has no admission authority`);
    }
    authority.admission = operation;
  }

  commitActivation(installation: Installation) {
    this.#state = { phase: "activated", installation };
    for (const waiter of this.#readyWaiters) {
      void installation.ready().then(waiter.resolve, waiter.reject);
    }
    this.#readyWaiters.clear();
  }

  prepareCommit(artifact: NormalizedArtifact<Reference>, state: RegistrationCommitState) {
    const authority = this.#authority;
    if (authority.phase !== "attached") throw this.unavailableError();
    return () => {
      authority.admission = undefined;
      authority.artifact = artifact;
      this.#manifest = artifact.manifest;
      this.#state = state;
    };
  }

  fail(error: unknown) {
    const failure = normalizeRegistrationFailure(error, this.manifestName);
    this.#state = {
      phase: "failed",
      installation: this.installation,
      failure: { retention: "live", error: failure },
    };
    this.#clearAdmission();
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    return failure;
  }

  discard(error: unknown) {
    const failure = this.fail(error);
    this.#state = {
      phase: "failed",
      installation: undefined,
      failure: { retention: "summary", summary: snapshotFailure(failure) },
    };
    this.#authority = { phase: "terminal" };
  }

  markRemoved() {
    const error = new PlatformError(
      "REGISTRATION_REMOVED",
      `Registration '${this.manifestName}' has been removed`,
    );
    this.#authority = { phase: "terminal" };
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

  #attachedAuthority() {
    const authority = this.#authority;
    return authority.phase === "attached" ? authority : undefined;
  }

  #clearAdmission() {
    const authority = this.#authority;
    if (authority.phase === "attached") authority.admission = undefined;
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
  if (error instanceof Error) return error;
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

function snapshotFailure(error: Error): TerminalRegistrationFailure {
  if (error instanceof PlatformError) {
    return {
      category: "coded",
      name: error.name,
      message: error.message,
      code: error.code,
      domain: "platform",
    };
  }
  if (error instanceof DougongError) {
    return {
      category: "coded",
      name: error.name,
      message: error.message,
      code: error.code,
      domain: "core",
    };
  }
  return {
    category: error instanceof TypeError ? "typeError" : "error",
    name: error.name,
    message: error.message,
  };
}

function restoreFailure(failure: TerminalRegistrationFailure): Error {
  let error: Error;
  if (failure.category === "coded") {
    error =
      failure.domain === "platform"
        ? new PlatformError(failure.code, failure.message)
        : new DougongError(failure.code, failure.message);
  } else {
    error =
      failure.category === "typeError"
        ? new TypeError(failure.message)
        : new Error(failure.message);
  }
  error.name = failure.name;
  return error;
}
