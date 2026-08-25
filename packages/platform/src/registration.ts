import { ErrorSummary, SerialQueue, type Installation } from "@dougongjs/core";
import type { Registration, NormalizedArtifact, PlatformChangeSet, Artifact } from "./platform-api";
import { PlatformError } from "./errors";
import type { ActivationPermit } from "./activation-gate";

export interface RegistrationPort<Reference> {
  readonly change: () => PlatformChangeSet<Reference>;
  readonly activateRegistration: (
    registration: RegistrationRecord<Reference>,
    signal: AbortSignal,
    permit?: ActivationPermit,
  ) => Promise<void>;
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

interface TerminalRegistrationFailure {
  readonly summary: ErrorSummary;
  readonly platformError: boolean;
}

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

/**
 * Internal state machine behind one public Registration.
 *
 * Two independent axes, which is why there are two state fields:
 *
 *   #authority   draft -> attached -> terminal    may this Registration act?
 *   #state       pending -> registered -> loading -> activated | failed | removed
 *
 * A Registration can be attached and failed at once — still ours, currently
 * broken, retryable. Collapsing the two would make that state unrepresentable.
 *
 * `admission` is the promise of the change that admitted this Registration.
 * `activate()` awaits it first, so activation triggered immediately after
 * `register()` waits for the registration to actually commit instead of racing it.
 */
export class RegistrationRecord<Reference> {
  #authority: RegistrationAuthority<Reference>;
  #manifest: NormalizedArtifact<Reference>["manifest"];
  #state: RegistrationState = { phase: "pending" };
  readonly #activationQueue = new SerialQueue();
  #activationController: AbortController | undefined;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly facade: Registration<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#authority = { phase: "draft", artifact };
    this.#manifest = artifact.manifest;
    this.facade = new RegistrationFacade(this);
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
        : state.failure.summary.summary.restore(
            state.failure.summary.platformError
              ? (code, message) => new PlatformError(code, message)
              : undefined,
          );
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

  async update(artifact: Artifact<Reference>): Promise<void> {
    const authority = this.#attachedAuthority();
    if (!authority) throw this.unavailableError();
    const change = authority.port.change();
    change.update(this.facade, artifact);
    await change.commit();
  }

  async remove(): Promise<void> {
    const authority = this.#attachedAuthority();
    if (!authority) {
      if (this.#state.phase === "removed" || this.#state.phase === "failed") return;
      throw this.unavailableError();
    }
    const change = authority.port.change();
    change.remove(this.facade);
    await change.commit();
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
    // Waiters are forwarded to the Installation rather than resolved here.
    // `ready()` on a Registration means "its Plugin has started", and only Core
    // knows that — activation merely means the Installation now exists.
    for (const waiter of this.#readyWaiters) {
      void installation.ready().then(waiter.resolve, waiter.reject);
    }
    this.#readyWaiters.clear();
  }

  /**
   * Splits validation from mutation: everything that can fail happens now, and
   * the returned closure only assigns. Platform calls it after the Core commit
   * succeeds, so a Registration's own state can never move ahead of the graph.
   */
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

  /**
   * Terminal counterpart to `fail()`, for a Registration that never made it in.
   * The failure is kept as an `ErrorSummary` so the record retains no live object
   * graph, and `platformError` remembers which class to rebuild — a
   * `PlatformError` must not come back as a plain Error and lose its code.
   */
  discard(error: unknown) {
    const failure = this.fail(error);
    this.#state = {
      phase: "failed",
      installation: undefined,
      failure: {
        retention: "summary",
        summary: {
          summary: new ErrorSummary(failure),
          platformError: failure instanceof PlatformError,
        },
      },
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
