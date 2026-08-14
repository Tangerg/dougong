import { DougongError, normalizeFailure } from "./errors";
import type { Lifetime } from "./lifetime";
import type { PluginDefinition, Provisions, Requirements } from "./plugin";
import type { GroupNode } from "./group";

export type InstallationStatus = "pending" | "active" | "stopping" | "failed" | "removed";

export type AnyPlugin = PluginDefinition<unknown, Requirements, Provisions, unknown>;

export interface InstallationSpec {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
}

export interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
  readonly lifetime: Lifetime;
}

export function createInstallationSpec(plugin: AnyPlugin, config: unknown): InstallationSpec {
  return Object.freeze({ plugin, config });
}

interface InstallationAttachment {
  spec: InstallationSpec;
  readonly group: GroupNode;
  notifyChanged: (() => void) | undefined;
}

interface TerminalPluginFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

type PluginFailureState =
  | { readonly phase: "none" }
  | { readonly phase: "live"; readonly error: Error }
  | { readonly phase: "terminal"; readonly summary: TerminalPluginFailure };

/**
 * A plugin installation is a stable identity whose declaration and runtime may
 * change. State transitions and ready waiters live here so orchestration code
 * cannot create a status that disagrees with the owned runtime.
 */
export class PluginInstallation {
  #status: InstallationStatus = "pending";
  #runtime: PluginRuntime | undefined;
  #failure: PluginFailureState = { phase: "none" };
  #readySettled = false;
  #readinessBarrier: Promise<void> | undefined;
  #attachment: InstallationAttachment | undefined;

  readonly groupId: string;

  readonly #readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();

  constructor(
    readonly id: string,
    readonly index: number,
    group: GroupNode,
    spec: InstallationSpec,
  ) {
    this.groupId = group.id;
    this.#attachment = { spec, group, notifyChanged: undefined };
  }

  attach(notifyChanged: () => void) {
    const attachment = this.#requireAttachment();
    if (attachment.notifyChanged) throw new TypeError(`Plugin '${this.id}' is already attached`);
    attachment.notifyChanged = notifyChanged;
  }

  get status() {
    return this.#status;
  }

  get runtime() {
    return this.#runtime;
  }

  get error() {
    if (this.#failure.phase === "live") return this.#failure.error;
    if (this.#failure.phase === "terminal") return restoreFailure(this.#failure.summary);
    if (this.#status === "removed") {
      return new DougongError("PLUGIN_REMOVED", `Plugin '${this.id}' has been removed`);
    }
    return undefined;
  }

  get group() {
    return this.#requireAttachment().group;
  }

  get spec() {
    return this.#requireAttachment().spec;
  }

  reconfigure(spec: InstallationSpec) {
    this.#requireAttachment().spec = spec;
  }

  ready() {
    const barrier = this.#readinessBarrier;
    if (barrier) return barrier.then(() => this.#readyFromCurrentState());
    return this.#readyFromCurrentState();
  }

  trackReadiness(operation: Promise<void>) {
    let barrier: Promise<void>;
    barrier = operation.then(
      () => {
        if (this.#readinessBarrier === barrier) this.#readinessBarrier = undefined;
      },
      (error) => {
        if (this.#readinessBarrier === barrier) this.#readinessBarrier = undefined;
        if (this.#status !== "active") throw error;
      },
    );
    this.#readinessBarrier = barrier;
    void barrier.catch(() => undefined);
  }

  #readyFromCurrentState(): Promise<void> {
    if (this.#readySettled) {
      if (this.#status === "active") return Promise.resolve();
      if (this.#status === "failed" || this.#status === "removed") {
        return Promise.reject(
          this.error ??
            new DougongError("PLUGIN_UNAVAILABLE", `Plugin '${this.id}' is ${this.#status}`),
        );
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.#readyWaiters.add({ resolve, reject });
    });
  }

  activate(runtime: PluginRuntime) {
    this.#runtime = runtime;
    this.#readySettled = false;
    this.#transition("active");
  }

  settleReady() {
    if (this.#readySettled) return;
    if (this.#status !== "active" && this.#status !== "failed" && this.#status !== "removed") {
      return;
    }
    this.#readySettled = true;
    if (this.#status === "active") {
      for (const waiter of this.#readyWaiters) waiter.resolve();
    } else {
      const error =
        this.error ??
        new DougongError("PLUGIN_UNAVAILABLE", `Plugin '${this.id}' is ${this.#status}`);
      for (const waiter of this.#readyWaiters) waiter.reject(error);
    }
    this.#readyWaiters.clear();
  }

  beginStopping() {
    if (!this.#runtime) return false;
    this.#transition("stopping");
    return true;
  }

  deactivate() {
    this.#runtime = undefined;
    this.#readySettled = false;
    this.#transition("pending");
  }

  fail(error: unknown) {
    this.#transitionToFailed(error);
  }

  discard(error: unknown) {
    const failure = this.#transitionToFailed(error);
    this.settleReady();
    this.#failure = { phase: "terminal", summary: snapshotFailure(failure) };
    this.#readinessBarrier = undefined;
    this.#attachment = undefined;
  }

  #transitionToFailed(error: unknown) {
    const failure = normalizeFailure(
      error,
      "PLUGIN_UNAVAILABLE",
      `Plugin '${this.id}' failed with a non-Error value`,
    );
    this.#runtime = undefined;
    this.#readySettled = false;
    this.#failure = { phase: "live", error: failure };
    this.#transition("failed", false);
    return failure;
  }

  remove() {
    this.#runtime = undefined;
    this.#readySettled = false;
    this.#transition("removed");
    this.#readinessBarrier = undefined;
    this.#attachment = undefined;
  }

  #transition(status: InstallationStatus, clearError = true) {
    this.#status = status;
    if (clearError) {
      this.#failure = { phase: "none" };
    }
    this.#attachment?.notifyChanged?.();
  }

  #requireAttachment() {
    const attachment = this.#attachment;
    if (!attachment) throw new TypeError(`Plugin '${this.id}' is no longer installed`);
    return attachment;
  }
}

function snapshotFailure(error: Error): TerminalPluginFailure {
  if (error instanceof DougongError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  return { name: error.name, message: error.message };
}

function restoreFailure(failure: TerminalPluginFailure): Error {
  const error =
    failure.code === undefined
      ? new Error(failure.message)
      : new DougongError(failure.code, failure.message);
  error.name = failure.name;
  return error;
}
