import { DougongError, ErrorSummary, normalizeFailure } from "./errors";
import type { Lifetime } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import type { NormalizedPlugin } from "./plugin";
import type { GroupNode } from "./group";

export interface InstallationDeclaration {
  readonly plugin: NormalizedPlugin;
  readonly config: unknown;
}

export interface Instance {
  readonly plugin: NormalizedPlugin;
  readonly config: unknown;
  readonly lifetime: Lifetime;
}

export function createInstallationDeclaration(
  plugin: NormalizedPlugin,
  config: unknown,
): InstallationDeclaration {
  return Object.freeze({ plugin, config });
}

interface InstallationAttachment {
  declaration: InstallationDeclaration;
  readonly group: GroupNode;
  notifyChanged: (() => void) | undefined;
}

/**
 * A failure that may recover keeps the live Error — its stack is the useful part
 * while the Installation is still in the graph. A discarded one keeps only an
 * `ErrorSummary`, because a terminal record must not retain the object graph
 * that was live when it failed.
 */
type InstallationFailure =
  | { readonly retention: "live"; readonly error: Error }
  | { readonly retention: "summary"; readonly summary: ErrorSummary };

type InstallationState =
  | { readonly phase: "pending" }
  | {
      readonly phase: "active";
      readonly instance: Instance;
      readonly readiness: "unsettled" | "settled";
    }
  | { readonly phase: "stopping"; readonly instance: Instance }
  | {
      readonly phase: "failed";
      readonly failure: InstallationFailure;
      readonly readiness: "unsettled" | "settled";
    }
  | { readonly phase: "removed"; readonly readiness: "unsettled" | "settled" };

/**
 * An installation is a stable identity whose declaration and active Instance
 * may change. State transitions and ready waiters live here so orchestration
 * code cannot create a status that disagrees with the owned Instance.
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
    declaration: InstallationDeclaration,
  ) {
    this.groupId = group.id;
    this.#attachment = { declaration, group, notifyChanged: undefined };
  }

  attach(notifyChanged: () => void) {
    const attachment = this.#requireAttachment();
    if (attachment.notifyChanged) throw new Error(`Installation '${this.id}' is already attached`);
    attachment.notifyChanged = notifyChanged;
  }

  get status(): LifecycleStatus {
    return this.#state.phase;
  }

  /** Whether the owning ChangeSet has granted this Installation Host authority. */
  get attached() {
    return this.#attachment?.notifyChanged !== undefined;
  }

  get instance() {
    const state = this.#state;
    return state.phase === "active" || state.phase === "stopping" ? state.instance : undefined;
  }

  get error() {
    const state = this.#state;
    if (state.phase === "failed") {
      return state.failure.retention === "live"
        ? state.failure.error
        : state.failure.summary.restore();
    }
    if (state.phase === "removed") {
      return new DougongError("INSTALLATION_REMOVED", `Installation '${this.id}' has been removed`);
    }
    return undefined;
  }

  get group() {
    return this.#requireAttachment().group;
  }

  get declaration() {
    return this.#requireAttachment().declaration;
  }

  replaceDeclaration(declaration: InstallationDeclaration) {
    this.#requireAttachment().declaration = declaration;
  }

  ready() {
    const pending = this.#pendingReadiness;
    if (pending) return pending.barrier.then(() => this.#readyFromCurrentState());
    return this.#readyFromCurrentState();
  }

  unavailableError() {
    return (
      this.error ??
      new DougongError(
        "INSTALLATION_UNAVAILABLE",
        `Installation '${this.id}' has not been committed`,
      )
    );
  }

  /**
   * Binds `ready()` to the change currently in flight.
   *
   * The `attempt` token is the point: a second change can start before the
   * first one's promise settles, and only the latest attempt is allowed to clear
   * the barrier. Without it, a stale resolution would report readiness for an
   * attempt that has already been superseded.
   *
   * A rejection is rethrown only when this Installation did not end up active.
   * A change that failed elsewhere in the batch but left this one running is not
   * this Installation's failure to report.
   */
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

  // A terminal state only answers `ready()` once its readiness has been settled.
  // Before that the outcome is still being decided by the change in flight, so
  // the caller joins the waiter set instead of being told a result that the
  // transaction might still roll back.
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

    const completion = Promise.withResolvers<void>();
    this.#readyWaiters.add(completion);
    return completion.promise;
  }

  activate(instance: Instance) {
    this.#transition({ phase: "active", instance, readiness: "unsettled" });
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
    this.#transition({ phase: "stopping", instance: state.instance });
    return true;
  }

  deactivate() {
    this.#transition({ phase: "pending" });
  }

  fail(error: unknown) {
    return this.#transitionToFailed(error);
  }

  /**
   * For an Installation that never made it into the graph. Unlike `fail()`, this
   * is terminal: readiness settles immediately, the attachment is dropped, and
   * the reason is kept as a summary rather than a live Error. The handle the
   * caller already holds stays usable and reports why it is dead.
   */
  discard(error: unknown) {
    const failure = this.#normalizeFailure(error);
    this.#transition({
      phase: "failed",
      failure: { retention: "summary", summary: new ErrorSummary(failure) },
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
    if (!attachment) throw new Error(`Installation '${this.id}' is no longer installed`);
    return attachment;
  }
}
