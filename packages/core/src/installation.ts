import { DougongError, RecordedFailure, normalizeFailure } from "./errors";
import type { Lifetime, LifetimeSnapshot } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import type { AnyPlugin, NormalizedPlugin, Plugin, Provisions, Requirements } from "./plugin";
import type { GroupNode } from "./group";
import { batchSnapshotNotifications, SnapshotPublisher, type SnapshotView } from "./snapshot-view";

type DeclaredInstallationUpdate<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> =
  | {
      readonly plugin: Plugin<Config, Requires, Provides, ConfigInput>;
      readonly config?: ConfigInput;
    }
  | { readonly plugin?: never; readonly config: ConfigInput };

type AnyPluginInstallationUpdate =
  | { readonly plugin: AnyPlugin; readonly config?: unknown }
  | { readonly plugin?: never; readonly config: unknown };

/** Replaces a declaration or config while preserving Installation identity and position. */
export type InstallationUpdate<Declaration extends AnyPlugin = AnyPlugin> =
  Declaration extends Plugin<infer Config, infer Requires, infer Provides, infer ConfigInput>
    ? DeclaredInstallationUpdate<Config, Requires, Provides, ConfigInput>
    : AnyPluginInstallationUpdate;

interface InstallationAuthority {
  readonly notifyChanged: () => void;
  readonly report: (error: unknown) => void;
  readonly settled: () => Promise<void>;
  readonly update: (change: InstallationUpdate) => Promise<void>;
  readonly remove: () => Promise<void>;
}

export interface InstallationSnapshot {
  readonly id: string;
  readonly pluginName: string;
  readonly groupId: string;
  readonly status: LifecycleStatus;
  readonly requires: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly lifetime?: SnapshotView<LifetimeSnapshot>;
  readonly error?: RecordedFailure;
}

export interface InstallationDeclaration {
  readonly plugin: NormalizedPlugin;
  readonly config: unknown;
}

export interface Instance {
  readonly plugin: NormalizedPlugin;
  readonly config: unknown;
  readonly lifetime: Lifetime;
  readonly diagnostics: SnapshotView<LifetimeSnapshot>;
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
  authority: Pick<InstallationAuthority, "settled" | "update" | "remove"> | undefined;
}

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
      readonly error: Error;
      readonly readiness: "unsettled" | "settled";
    }
  | { readonly phase: "removed"; readonly readiness: "unsettled" | "settled" }
  | { readonly phase: "discarded"; readonly error: RecordedFailure };

/**
 * An installation is a stable identity whose declaration and active Instance
 * may change. State transitions and ready waiters live here so orchestration
 * code cannot create a status that disagrees with the owned Instance.
 */
export class InstallationRecord {
  #state: InstallationState = { phase: "pending" };
  #attachment: InstallationAttachment | undefined;
  #notifications: Pick<InstallationAuthority, "notifyChanged" | "report"> | undefined;

  readonly #publisher: SnapshotPublisher<InstallationSnapshot>;
  readonly #pluginName: string;
  readonly diagnostics: SnapshotView<InstallationSnapshot>;

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
    this.#attachment = { declaration, group, authority: undefined };
    this.#pluginName = declaration.plugin.name;
    this.#publisher = new SnapshotPublisher(
      () => this.#snapshot(),
      (error) => this.#notifications?.report(error),
    );
    this.diagnostics = this.#publisher.view;
  }

  attach(authority: InstallationAuthority) {
    const attachment = this.#requireAttachment();
    if (attachment.authority) throw new Error(`Installation '${this.id}' is already attached`);
    attachment.authority = {
      settled: authority.settled,
      update: authority.update,
      remove: authority.remove,
    };
    this.#notifications = { notifyChanged: authority.notifyChanged, report: authority.report };
  }

  get status(): LifecycleStatus {
    return this.#state.phase === "discarded" ? "failed" : this.#state.phase;
  }

  /** Whether the owning ChangeSet has granted this Installation Host authority. */
  get hasAuthority() {
    return (
      this.#attachment?.authority !== undefined &&
      this.#state.phase !== "removed" &&
      this.#state.phase !== "discarded"
    );
  }

  get instance() {
    const state = this.#state;
    return state.phase === "active" || state.phase === "stopping" ? state.instance : undefined;
  }

  get error() {
    const state = this.#state;
    if (state.phase === "failed" || state.phase === "discarded") {
      return state.error;
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
    this.#publisher.invalidate();
  }

  ready() {
    const boundary = this.#attachment?.authority?.settled();
    return boundary
      ? boundary.then(() => this.#readyFromCurrentState())
      : this.#readyFromCurrentState();
  }

  async requestUpdate(change: InstallationUpdate) {
    const authority = this.#attachment?.authority;
    if (!this.hasAuthority || !authority) throw this.unavailableError();
    await authority.update(change);
  }

  async requestRemoval() {
    if (this.#state.phase === "removed" || this.#state.phase === "discarded") return;
    const attachment = this.#attachment;
    if (!attachment) return;
    if (!attachment.authority) throw this.unavailableError();
    await attachment.authority.remove();
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

  // A terminal state only answers `ready()` once its readiness has been settled.
  // Before that the outcome is still being decided by the change in flight, so
  // the caller joins the waiter set instead of being told a result that the
  // transaction might still roll back.
  #readyFromCurrentState(): Promise<void> {
    const state = this.#state;
    if (state.phase === "discarded") return Promise.reject(state.error);
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
    if (state.phase === "removed") {
      try {
        this.#publisher.dispose();
      } finally {
        this.#notifications = undefined;
      }
    }
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
   * the reason is kept as a RecordedFailure rather than the live Error. The handle the
   * caller already holds stays usable and reports why it is dead.
   */
  discard(error: unknown) {
    const failure = new RecordedFailure(this.#normalizeFailure(error));
    this.#transition({
      phase: "discarded",
      error: failure,
    });
    for (const waiter of this.#readyWaiters) waiter.reject(failure);
    this.#readyWaiters.clear();
    try {
      this.#publisher.dispose();
    } finally {
      this.#attachment = undefined;
      this.#notifications = undefined;
    }
  }

  #transitionToFailed(error: unknown) {
    const failure = this.#normalizeFailure(error);
    this.#transition({
      phase: "failed",
      error: failure,
      readiness: "unsettled",
    });
    return failure;
  }

  remove() {
    this.#transition({ phase: "removed", readiness: "unsettled" });
    this.#attachment = undefined;
  }

  #transition(state: InstallationState) {
    batchSnapshotNotifications(() => {
      this.#state = state;
      this.#publisher.invalidate();
      this.#notifications?.notifyChanged();
    });
  }

  #snapshot(): InstallationSnapshot {
    const plugin = this.#attachment?.declaration.plugin;
    const instance = this.instance;
    const error = this.error;
    return Object.freeze({
      id: this.id,
      pluginName: this.#pluginName,
      groupId: this.groupId,
      status: this.status,
      requires: Object.freeze(
        Object.values(plugin?.requires ?? {}).map((requirement) =>
          requirement.kind === "optional" ? requirement.service.id : requirement.id,
        ),
      ),
      provides: Object.freeze(Object.values(plugin?.provides ?? {}).map((token) => token.id)),
      ...(instance ? { lifetime: instance.diagnostics } : {}),
      ...(error ? { error: new RecordedFailure(error) } : {}),
    });
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
