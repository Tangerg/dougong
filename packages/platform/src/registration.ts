import {
  DougongError,
  SerialQueue,
  type Installation,
  type Provisions,
  type Requirements,
} from "@dougongjs/core";
import type { Registration, NormalizedArtifact, PlatformChangeSet, Artifact } from "./platform-api";
import { PlatformError } from "./errors";

export interface RegistrationRecordOwner<Reference> {
  change(): PlatformChangeSet<Reference>;
  activateRegistration(
    registration: RegistrationRecord<Reference>,
    stack: ReadonlyArray<RegistrationRecord<Reference>>,
    signal: AbortSignal,
  ): Promise<void>;
}

type RegistrationAuthority<Reference> =
  | { readonly phase: "draft"; artifact: NormalizedArtifact<Reference> }
  | {
      readonly phase: "attached";
      readonly owner: RegistrationRecordOwner<Reference>;
      artifact: NormalizedArtifact<Reference>;
    }
  | { readonly phase: "terminal" };

type TerminalRegistrationFailure =
  | { readonly name: string; readonly message: string }
  | {
      readonly name: string;
      readonly message: string;
      readonly code: string;
      readonly domain: "core" | "platform";
    };

type RegistrationFailure =
  | { readonly retention: "live"; readonly error: Error }
  | { readonly retention: "summary"; readonly summary: TerminalRegistrationFailure };

type RegistrationState =
  | { readonly phase: "pending" }
  | { readonly phase: "registered"; readonly coreHandle: Installation | undefined }
  | { readonly phase: "loading"; readonly coreHandle: Installation | undefined }
  | { readonly phase: "activated"; readonly coreHandle: Installation }
  | {
      readonly phase: "failed";
      readonly coreHandle: Installation | undefined;
      readonly failure: RegistrationFailure;
    }
  | { readonly phase: "removed" };

export type RegistrationCoreState = Extract<
  RegistrationState,
  { readonly phase: "registered" | "activated" }
>;

class RegistrationHandle<Reference> implements Registration<Reference> {
  readonly #registration: RegistrationRecord<Reference>;

  constructor(registration: RegistrationRecord<Reference>) {
    this.#registration = registration;
    Object.freeze(this);
  }

  get name() {
    return this.#registration.name;
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

/** Internal stable identity and activation state machine behind an opaque handle. */
export class RegistrationRecord<Reference> {
  #authority: RegistrationAuthority<Reference>;
  #manifest: NormalizedArtifact<Reference>["manifest"];
  #state: RegistrationState = { phase: "pending" };
  readonly #activationQueue = new SerialQueue();
  #activationController: AbortController | undefined;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly handle: Registration<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#authority = { phase: "draft", artifact };
    this.#manifest = artifact.manifest;
    this.handle = new RegistrationHandle(this);
  }

  attach(owner: RegistrationRecordOwner<Reference>) {
    const authority = this.#authority;
    if (authority.phase !== "draft") {
      throw new TypeError(`Registration '${this.name}' is already sealed`);
    }
    this.#authority = { phase: "attached", owner, artifact: authority.artifact };
  }

  get name() {
    return this.#manifest.name;
  }

  get manifest() {
    return this.#manifest;
  }

  get artifact() {
    const authority = this.#authority;
    if (authority.phase === "terminal") throw this.#unavailable();
    return authority.artifact;
  }

  get status() {
    return this.#state.phase;
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
        `Registration '${this.name}' has been removed`,
      );
    }
    return undefined;
  }

  get coreHandle() {
    const state = this.#state;
    return "coreHandle" in state ? state.coreHandle : undefined;
  }

  ready() {
    const state = this.#state;
    if (state.phase === "activated") {
      return state.coreHandle.ready();
    }
    if (state.phase === "failed" || state.phase === "removed") {
      return Promise.reject(
        this.error ??
          new PlatformError(
            "REGISTRATION_UNAVAILABLE",
            `Registration '${this.name}' is unavailable`,
          ),
      );
    }
    return new Promise<void>((resolve, reject) => this.#readyWaiters.add({ resolve, reject }));
  }

  activate() {
    const owner = this.#attachedOwner();
    if (!owner) return Promise.reject(this.#unavailable());
    return this.#enqueueActivation((signal) => owner.activateRegistration(this, [], signal));
  }

  async update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>): Promise<void> {
    const owner = this.#attachedOwner();
    if (!owner) throw this.#unavailable();
    await owner.change().update(this.handle, artifact).commit();
  }

  async remove(): Promise<void> {
    const owner = this.#attachedOwner();
    if (!owner) {
      if (this.#state.phase === "removed" || this.#state.phase === "failed") return;
      throw this.#unavailable();
    }
    await owner.change().remove(this.handle).commit();
  }

  activateAsDependency(stack: ReadonlyArray<RegistrationRecord<Reference>>) {
    const owner = this.#attachedOwner();
    if (!owner) return Promise.reject(this.#unavailable());
    return this.#enqueueActivation((signal) => owner.activateRegistration(this, stack, signal));
  }

  beginActivation() {
    this.#state = { phase: "loading", coreHandle: this.coreHandle };
  }

  commitActivation(handle: Installation) {
    this.#state = { phase: "activated", coreHandle: handle };
    for (const waiter of this.#readyWaiters) {
      void handle.ready().then(waiter.resolve, waiter.reject);
    }
    this.#readyWaiters.clear();
  }

  prepareArtifactCommit(artifact: NormalizedArtifact<Reference>, state: RegistrationCoreState) {
    const authority = this.#authority;
    if (authority.phase !== "attached") throw this.#unavailable();
    return () => {
      authority.artifact = artifact;
      this.#manifest = artifact.manifest;
      this.#state = state;
    };
  }

  fail(error: unknown) {
    const failure = normalizeFailure(error, this.name);
    this.#state = {
      phase: "failed",
      coreHandle: this.coreHandle,
      failure: { retention: "live", error: failure },
    };
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    return failure;
  }

  discard(error: unknown) {
    const failure = this.fail(error);
    this.#state = {
      phase: "failed",
      coreHandle: undefined,
      failure: { retention: "summary", summary: snapshotFailure(failure) },
    };
    this.#authority = { phase: "terminal" };
  }

  markRemoved() {
    const error = new PlatformError(
      "REGISTRATION_REMOVED",
      `Registration '${this.name}' has been removed`,
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

  #attachedOwner() {
    const authority = this.#authority;
    return authority.phase === "attached" ? authority.owner : undefined;
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

  #unavailable() {
    return (
      this.error ??
      new PlatformError(
        "REGISTRATION_UNAVAILABLE",
        `Registration '${this.name}' has not been committed`,
      )
    );
  }
}

function normalizeFailure(error: unknown, name: string): Error {
  if (error instanceof Error) return error;
  return new PlatformError(
    "REGISTRATION_UNAVAILABLE",
    `Registration '${name}' failed with a non-Error value`,
    { cause: error },
  );
}

function snapshotFailure(error: Error): TerminalRegistrationFailure {
  if (error instanceof PlatformError) {
    return { name: error.name, message: error.message, code: error.code, domain: "platform" };
  }
  if (error instanceof DougongError) {
    return { name: error.name, message: error.message, code: error.code, domain: "core" };
  }
  return { name: error.name, message: error.message };
}

function restoreFailure(failure: TerminalRegistrationFailure): Error {
  let error: Error;
  if (!("code" in failure)) error = new Error(failure.message);
  else if (failure.domain === "platform") {
    error = new PlatformError(failure.code, failure.message);
  } else {
    error = new DougongError(failure.code, failure.message);
  }
  error.name = failure.name;
  return error;
}
