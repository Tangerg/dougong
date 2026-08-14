import { DougongError, type PluginHandle, type Provisions, type Requirements } from "@dougong/core";
import type {
  ManagedPlugin,
  NormalizedArtifact,
  PlatformChangeSet,
  PluginArtifact,
} from "./platform-api";
import type { ManagedPluginStatus } from "./diagnostics";
import { PlatformError } from "./errors";

export interface ManagedPluginRegistrationOwner<Reference> {
  change(): PlatformChangeSet<Reference>;
  activateRegistration(
    registration: ManagedPluginRegistration<Reference>,
    stack: ReadonlyArray<ManagedPluginRegistration<Reference>>,
    signal: AbortSignal,
  ): Promise<void>;
}

type ManagedPluginAuthority<Reference> =
  | { readonly phase: "draft"; artifact: NormalizedArtifact<Reference> }
  | {
      readonly phase: "attached";
      readonly owner: ManagedPluginRegistrationOwner<Reference>;
      artifact: NormalizedArtifact<Reference>;
    }
  | { readonly phase: "terminal" };

type TerminalManagedPluginFailure =
  | { readonly name: string; readonly message: string }
  | {
      readonly name: string;
      readonly message: string;
      readonly code: string;
      readonly domain: "core" | "platform";
    };

type ManagedPluginFailureState =
  | { readonly phase: "none" }
  | { readonly phase: "live"; readonly error: Error }
  | { readonly phase: "terminal"; readonly summary: TerminalManagedPluginFailure };

class ManagedPluginHandleImpl<Reference> implements ManagedPlugin<Reference> {
  readonly #registration: ManagedPluginRegistration<Reference>;

  constructor(registration: ManagedPluginRegistration<Reference>) {
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
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>) {
    return this.#registration.update(artifact);
  }

  remove() {
    return this.#registration.remove();
  }
}

/** Internal stable identity and activation state machine behind an opaque handle. */
export class ManagedPluginRegistration<Reference> {
  #authority: ManagedPluginAuthority<Reference>;
  #manifest: NormalizedArtifact<Reference>["manifest"];
  #status: ManagedPluginStatus = "pending";
  #failure: ManagedPluginFailureState = { phase: "none" };
  #coreHandle: PluginHandle | undefined;
  #activationQueue: Promise<void> = Promise.resolve();
  #activationController: AbortController | undefined;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly handle: ManagedPlugin<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#authority = { phase: "draft", artifact };
    this.#manifest = artifact.manifest;
    this.handle = new ManagedPluginHandleImpl(this);
  }

  attach(owner: ManagedPluginRegistrationOwner<Reference>) {
    const authority = this.#authority;
    if (authority.phase !== "draft") {
      throw new TypeError(`Plugin '${this.name}' registration is already sealed`);
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
    return this.#status;
  }

  get error() {
    if (this.#failure.phase === "live") return this.#failure.error;
    if (this.#failure.phase === "terminal") return restoreFailure(this.#failure.summary);
    if (this.#status === "removed") {
      return new PlatformError("PLUGIN_REMOVED", `Plugin '${this.name}' has been removed`);
    }
    return undefined;
  }

  get coreHandle() {
    return this.#coreHandle;
  }

  ready() {
    if (this.#status === "activated") {
      const handle = this.#coreHandle;
      return handle
        ? handle.ready()
        : Promise.reject(new TypeError(`Activated plugin '${this.name}' has no Core handle`));
    }
    if (this.#status === "failed" || this.#status === "removed") {
      return Promise.reject(
        this.error ??
          new PlatformError("PLUGIN_UNAVAILABLE", `Plugin '${this.name}' is unavailable`),
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
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>): Promise<void> {
    const owner = this.#attachedOwner();
    if (!owner) throw this.#unavailable();
    await owner.change().update(this.handle, artifact).commit();
  }

  async remove(): Promise<void> {
    const owner = this.#attachedOwner();
    if (!owner) {
      if (this.#status === "removed" || this.#status === "failed") return;
      throw this.#unavailable();
    }
    await owner.change().remove(this.handle).commit();
  }

  activateAsDependency(stack: ReadonlyArray<ManagedPluginRegistration<Reference>>) {
    const owner = this.#attachedOwner();
    if (!owner) return Promise.reject(this.#unavailable());
    return this.#enqueueActivation((signal) => owner.activateRegistration(this, stack, signal));
  }

  beginActivation() {
    this.#failure = { phase: "none" };
    this.#status = "loading";
  }

  commitActivation(handle: PluginHandle) {
    this.#coreHandle = handle;
    this.#failure = { phase: "none" };
    this.#status = "activated";
    for (const waiter of this.#readyWaiters) {
      void handle.ready().then(waiter.resolve, waiter.reject);
    }
    this.#readyWaiters.clear();
  }

  commitArtifact(
    artifact: NormalizedArtifact<Reference>,
    handle: PluginHandle | undefined,
    activated = false,
  ) {
    const authority = this.#authority;
    if (authority.phase !== "attached") throw this.#unavailable();
    authority.artifact = artifact;
    this.#manifest = artifact.manifest;
    this.#coreHandle = handle;
    this.#failure = { phase: "none" };
    this.#status = activated ? "activated" : "registered";
  }

  fail(error: unknown) {
    const failure = normalizeFailure(error, this.name);
    this.#failure = { phase: "live", error: failure };
    this.#status = "failed";
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    return failure;
  }

  discard(error: unknown) {
    const failure = this.fail(error);
    this.#failure = { phase: "terminal", summary: snapshotFailure(failure) };
    this.#authority = { phase: "terminal" };
  }

  markRemoved() {
    const error = new PlatformError("PLUGIN_REMOVED", `Plugin '${this.name}' has been removed`);
    this.#coreHandle = undefined;
    this.#authority = { phase: "terminal" };
    this.#failure = { phase: "none" };
    this.#status = "removed";
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  cancelActivation() {
    this.#activationController?.abort();
  }

  whenActivationSettled() {
    return this.#activationQueue;
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
    const result = this.#activationQueue.then(run, run);
    this.#activationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #unavailable() {
    return (
      this.error ??
      new PlatformError(
        "PLUGIN_UNAVAILABLE",
        `Plugin '${this.name}' registration has not been committed`,
      )
    );
  }
}

function normalizeFailure(error: unknown, pluginName: string): Error {
  if (error instanceof Error) return error;
  return new PlatformError(
    "PLUGIN_UNAVAILABLE",
    `Plugin '${pluginName}' failed with a non-Error value`,
    { cause: error },
  );
}

function snapshotFailure(error: Error): TerminalManagedPluginFailure {
  if (error instanceof PlatformError) {
    return { name: error.name, message: error.message, code: error.code, domain: "platform" };
  }
  if (error instanceof DougongError) {
    return { name: error.name, message: error.message, code: error.code, domain: "core" };
  }
  return { name: error.name, message: error.message };
}

function restoreFailure(failure: TerminalManagedPluginFailure): Error {
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
