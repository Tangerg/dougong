import { DougongError, normalizeFailure } from "./errors";
import type { Lifetime } from "./lifetime";
import type { Plugin, Provisions, Requirements } from "./plugin";
import type { GroupNode } from "./group";

export type InstallationStatus = "pending" | "active" | "stopping" | "failed" | "removed";

export type AnyPlugin = Plugin<unknown, Requirements, Provisions, unknown>;

export interface InstallationSpec {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
}

export interface InstallationRuntime {
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

interface TerminalFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

type InstallationFailure =
  | { readonly retention: "live"; readonly error: Error }
  | { readonly retention: "summary"; readonly summary: TerminalFailure };

type InstallationState =
  | { readonly phase: "pending" }
  | {
      readonly phase: "active";
      readonly runtime: InstallationRuntime;
      readonly readiness: "unsettled" | "settled";
    }
  | { readonly phase: "stopping"; readonly runtime: InstallationRuntime }
  | {
      readonly phase: "failed";
      readonly failure: InstallationFailure;
      readonly readiness: "unsettled" | "settled";
    }
  | { readonly phase: "removed"; readonly readiness: "unsettled" | "settled" };

/**
 * A plugin installation is a stable identity whose declaration and runtime may
 * change. State transitions and ready waiters live here so orchestration code
 * cannot create a status that disagrees with the owned runtime.
 */
export class InstallationRecord {
  #state: InstallationState = { phase: "pending" };
  #pendingReadiness: { readonly attempt: object; readonly barrier: Promise<void> } | undefined;
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
    if (attachment.notifyChanged)
      throw new TypeError(`Installation '${this.id}' is already attached`);
    attachment.notifyChanged = notifyChanged;
  }

  get status() {
    return this.#state.phase;
  }

  get runtime() {
    const state = this.#state;
    return state.phase === "active" || state.phase === "stopping" ? state.runtime : undefined;
  }

  get error() {
    const state = this.#state;
    if (state.phase === "failed") {
      return state.failure.retention === "live"
        ? state.failure.error
        : restoreFailure(state.failure.summary);
    }
    if (state.phase === "removed") {
      return new DougongError("INSTALLATION_REMOVED", `Installation '${this.id}' has been removed`);
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
    const pending = this.#pendingReadiness;
    if (pending) return pending.barrier.then(() => this.#readyFromCurrentState());
    return this.#readyFromCurrentState();
  }

  trackReadiness(operation: Promise<void>) {
    const attempt = {};
    const barrier = operation.then(
      () => {
        if (this.#pendingReadiness?.attempt === attempt) this.#pendingReadiness = undefined;
      },
      (error) => {
        if (this.#pendingReadiness?.attempt === attempt) this.#pendingReadiness = undefined;
        if (this.#state.phase !== "active") throw error;
      },
    );
    this.#pendingReadiness = { attempt, barrier };
    // ready() owns this barrier's failure; mark the internal observer branch handled.
    void barrier.catch(() => undefined);
  }

  #readyFromCurrentState(): Promise<void> {
    const state = this.#state;
    if (
      (state.phase === "active" || state.phase === "failed" || state.phase === "removed") &&
      state.readiness === "settled"
    ) {
      if (state.phase === "active") return Promise.resolve();
      if (state.phase === "failed" || state.phase === "removed") {
        return Promise.reject(
          this.error ??
            new DougongError(
              "INSTALLATION_UNAVAILABLE",
              `Installation '${this.id}' is ${state.phase}`,
            ),
        );
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.#readyWaiters.add({ resolve, reject });
    });
  }

  activate(runtime: InstallationRuntime) {
    this.#transition({ phase: "active", runtime, readiness: "unsettled" });
  }

  settleReady() {
    const state = this.#state;
    if (state.phase !== "active" && state.phase !== "failed" && state.phase !== "removed") {
      return;
    }
    if (state.readiness === "settled") return;
    this.#state = { ...state, readiness: "settled" };
    if (state.phase === "active") {
      for (const waiter of this.#readyWaiters) waiter.resolve();
    } else {
      const error =
        this.error ??
        new DougongError("INSTALLATION_UNAVAILABLE", `Installation '${this.id}' is ${state.phase}`);
      for (const waiter of this.#readyWaiters) waiter.reject(error);
    }
    this.#readyWaiters.clear();
  }

  beginStopping() {
    const state = this.#state;
    if (state.phase !== "active") return false;
    this.#transition({ phase: "stopping", runtime: state.runtime });
    return true;
  }

  deactivate() {
    this.#transition({ phase: "pending" });
  }

  fail(error: unknown) {
    this.#transitionToFailed(error);
  }

  discard(error: unknown) {
    const failure = this.#normalizeFailure(error);
    this.#transition({
      phase: "failed",
      failure: { retention: "summary", summary: snapshotFailure(failure) },
      readiness: "settled",
    });
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    this.#pendingReadiness = undefined;
    this.#attachment = undefined;
  }

  #transitionToFailed(error: unknown) {
    const failure = this.#normalizeFailure(error);
    this.#transition({
      phase: "failed",
      failure: { retention: "live", error: failure },
      readiness: "unsettled",
    });
    return failure;
  }

  remove() {
    this.#transition({ phase: "removed", readiness: "unsettled" });
    this.#pendingReadiness = undefined;
    this.#attachment = undefined;
  }

  #transition(state: InstallationState) {
    this.#state = state;
    this.#attachment?.notifyChanged?.();
  }

  #normalizeFailure(error: unknown) {
    return normalizeFailure(
      error,
      "INSTALLATION_UNAVAILABLE",
      `Installation '${this.id}' failed with a non-Error value`,
    );
  }

  #requireAttachment() {
    const attachment = this.#attachment;
    if (!attachment) throw new TypeError(`Installation '${this.id}' is no longer installed`);
    return attachment;
  }
}

function snapshotFailure(error: Error): TerminalFailure {
  if (error instanceof DougongError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  return { name: error.name, message: error.message };
}

function restoreFailure(failure: TerminalFailure): Error {
  const error =
    failure.code === undefined
      ? new Error(failure.message)
      : new DougongError(failure.code, failure.message);
  error.name = failure.name;
  return error;
}
