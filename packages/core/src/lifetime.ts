// Structured ownership. Everything an Instance creates during `setup()` — child
// lifetimes, background tasks, event listeners, contributions, cleanups — is
// owned by a Lifetime and released when it disposes. A Plugin that only uses the
// context it was given cannot leak, because there is nowhere to put a resource
// that is not owned.
//
// Two properties are worth stating before reading the code:
//
// Terminal resources detach. A finished task, a disposed cleanup, a withdrawn
// contribution removes itself from its owner's set, so a long-lived Instance that
// spawns a million short tasks holds none of them. That is what
// `LifetimeResources.release` is for, and why every record is handed its own
// release function rather than searching for itself later.
//
// Disposal order is fixed and not alphabetical:
//
//   1. seal the subtree; listeners, subscriptions, views, contributions withdraw
//   2. abort the signal                                 cancel in-flight work
//   3. tasks, children, cleanups                        await completion
//
// Capabilities go first so nothing new arrives mid-teardown; cancellation comes
// before awaiting, or a task waiting on its signal would never finish; user
// cleanups run last, when the resources they might touch are already quiet.

import type { Event, ExtensionPoint } from "./contracts";
import type { Contribution, ContributionLeaseKind } from "./contribution-store";
import { DougongError, isCancellationReason } from "./errors";
import type { EventListener } from "./event-hub";
import type { LifetimeSnapshot } from "./lifetime-diagnostics";
import { batchSnapshotNotifications, SnapshotPublisher } from "./snapshot-view";
import {
  asyncDisposeSymbol,
  type AsyncDisposable,
  type Disposable,
  type Publication,
  type Resource,
  type StagedResource,
} from "./resource";

export type { LifetimePhase, LifetimeSnapshot } from "./lifetime-diagnostics";

export interface Logger {
  readonly debug: (message: unknown, ...details: unknown[]) => void;
  readonly info: (message: unknown, ...details: unknown[]) => void;
  readonly warn: (message: unknown, ...details: unknown[]) => void;
  readonly error: (message: unknown, ...details: unknown[]) => void;
}

/**
 * Structural, so `console` and any four-method object both qualify without
 * importing a Dougong type. The try/catch is for hostile getters: a validator
 * must not throw the very error it was asked to prevent.
 */
export function isLogger(value: unknown): value is Logger {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    const candidate = value as Partial<Logger>;
    return [candidate.debug, candidate.info, candidate.warn, candidate.error].every(
      (method) => typeof method === "function",
    );
  } catch {
    return false;
  }
}

export interface InstanceMeta {
  readonly hostName: string;
  readonly pluginName: string;
  readonly installationId: string;
  readonly groupId: string;
}

export interface Task<T = void> extends AsyncDisposable {
  readonly result: Promise<T>;
}

export type Cleanup = () => unknown;
export type BackgroundTask<T> = (signal: AbortSignal) => T | PromiseLike<T>;
type EventArguments<T> = [T] extends [void] ? [payload?: T] : [payload: T];

// One shared reason object, so `isCancellationReason` can recognise a disposal
// by identity. An `AbortError` name alone is a convention that unrelated code
// also uses; identity is proof that this disposal caused it.
const disposalReason = Object.freeze(new DOMException("Resource disposed", "AbortError"));

/**
 * The complete set of things an Instance can do. Seven members, each returning
 * something the Lifetime already owns — there is no `register()` that takes a
 * resource from elsewhere, which is why ownership is structural rather than a
 * convention Plugin authors have to follow.
 */
export interface LifetimeOperations {
  readonly signal: AbortSignal;
  readonly cleanup: (dispose: Cleanup) => AsyncDisposable;
  readonly lifetime: (label: string) => LifetimeContext;
  readonly spawn: <T>(task: BackgroundTask<T>) => Task<T>;
  readonly on: <T>(token: Event<T>, listener: EventListener<T>) => Disposable;
  readonly emit: <T>(token: Event<T>, ...payload: EventArguments<T>) => Promise<void>;
  readonly contribute: <T>(token: ExtensionPoint<T>, key: string, value: T) => Contribution<T>;
}

export interface LifetimeContext extends LifetimeOperations, AsyncDisposable {}

export interface LifetimePort {
  readonly stageOn: <T>(
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ) => StagedResource<Disposable>;
  readonly emit: <T>(token: Event<T>, payload: T) => Promise<void>;
  readonly stageContribution: <T>(
    installationId: string,
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ) => StagedResource<Contribution<T>>;
  readonly writeLog: (
    level: keyof Logger,
    message: unknown,
    meta: InstanceMeta,
    details: readonly unknown[],
  ) => void;
  readonly report: (error: unknown) => void;
}

/**
 * Whether this Instance's declarations are visible yet — one cell, owned by the
 * root Lifetime and read by every scope beneath it.
 *
 * Staging belongs to the activation, not to an individual scope: everything
 * declared during `setup()` becomes visible together, and anything declared
 * afterwards is visible at once. Giving each Lifetime its own copy would let one
 * fact advance in as many places as there are scopes, and a scope that could not
 * advance its copy — one that began disposing during `setup()` — would have to
 * be arbitrated instead of simply reading the owner.
 */
class DeclarationPhase {
  #published = false;

  get published() {
    return this.#published;
  }

  publish() {
    this.#published = true;
  }
}

interface LifetimeOptions {
  readonly parentSignal?: AbortSignal;
  readonly parent?: {
    readonly detach: (lifetime: Lifetime) => void;
    readonly diagnostics: SnapshotPublisher<LifetimeSnapshot>;
    readonly label: string;
    readonly declarations: DeclarationPhase;
  };
}

interface LifetimeDisposal {
  readonly lifetime: Lifetime;
  readonly errors: unknown[];
  readonly controller: AbortController;
  readonly finish: () => void;
}

interface LifetimeBinding {
  readonly port: LifetimePort;
  readonly diagnostics: SnapshotPublisher<LifetimeSnapshot>;
}

/** Owns live resource membership; diagnostics read its size without separate counters. */
class LifetimeResources<T extends Resource> implements Iterable<T> {
  readonly #resources = new Set<T>();
  #changed: (() => void) | undefined;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  get size() {
    return this.#resources.size;
  }

  add(resource: T) {
    if (this.#resources.has(resource)) throw new Error("Lifetime already owns this resource");
    this.#resources.add(resource);
    this.#changed?.();
  }

  own(resource: T) {
    this.add(resource);
    return () => this.release(resource);
  }

  readonly release = (resource: T) => {
    if (!this.#resources.delete(resource)) return false;
    this.#changed?.();
    return true;
  };

  /**
   * Disposes in reverse creation order, collecting failures rather than
   * throwing. Later resources may depend on earlier ones, and a resource that
   * refuses to shut down cleanly must not strand its siblings. The caller
   * aggregates the collected errors.
   */
  async dispose(errors: unknown[]) {
    try {
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.dispose();
        } catch (error) {
          errors.push(error);
        } finally {
          this.release(resource);
        }
      }
    } finally {
      this.#changed = undefined;
    }
  }

  /** Capability withdrawal must finish without yielding to callbacks or tasks. */
  disposeSynchronously<U extends Disposable>(this: LifetimeResources<U>, errors: unknown[]) {
    try {
      for (const resource of [...this.#resources].reverse()) {
        try {
          resource.dispose();
        } catch (error) {
          errors.push(error);
        } finally {
          this.release(resource);
        }
      }
    } finally {
      this.#changed = undefined;
    }
  }

  [Symbol.iterator]() {
    return this.#resources[Symbol.iterator]();
  }
}

type CleanupRecordState =
  | {
      readonly phase: "active";
      readonly cleanup: Cleanup;
      readonly detachFromParent: (resource: AsyncDisposable) => void;
    }
  | { readonly phase: "disposing"; readonly completion: Promise<void> }
  | { readonly phase: "disposed" };

class CleanupRecord implements AsyncDisposable {
  #state: CleanupRecordState;

  constructor(cleanup: Cleanup, detachFromParent: (resource: AsyncDisposable) => void) {
    this.#state = { phase: "active", cleanup, detachFromParent };
    Object.freeze(this);
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();
    const completion = Promise.resolve()
      .then(async () => {
        try {
          await state.cleanup();
        } finally {
          state.detachFromParent(this);
        }
      })
      .finally(() => {
        this.#state = { phase: "disposed" };
      });
    this.#state = { phase: "disposing", completion };
    return completion;
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }
}

type TaskState =
  | { readonly phase: "running"; readonly controller: AbortController }
  | { readonly phase: "disposing"; readonly completion: Promise<void> }
  | { readonly phase: "settled" };

/**
 * One background task. Three things it has to get right:
 *
 * A task that finishes detaches itself from its Lifetime, so an Instance that
 * spawns work in a loop does not accumulate settled tasks.
 *
 * Its abort listener on the parent signal is removed the moment it settles,
 * because a listener on a long-lived signal is itself a retained reference.
 *
 * A rejection that is not a cancellation goes to `report()`. A background task
 * has no caller to return an error to, so this is where it would otherwise
 * vanish — and `dispose()` deliberately resolves rather than rejects, since
 * cancelling a task is not a failure of whoever cancelled it.
 */
class TaskRecord<T> implements Task<T> {
  #detachParentAbortListener: (() => void) | undefined;
  #detachFromParent: ((task: AsyncDisposable) => void) | undefined;
  #state: TaskState;
  readonly result: Promise<T>;

  constructor(
    parentSignal: AbortSignal,
    task: BackgroundTask<T>,
    report: (error: unknown) => void,
    detachFromParent: (task: AsyncDisposable) => void,
  ) {
    const controller = new AbortController();
    this.#state = { phase: "running", controller };
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#detachParentAbortListener = () => parentSignal.removeEventListener("abort", abort);
    this.#detachFromParent = detachFromParent;
    // Already-aborted parent: `addEventListener` would never fire, so the abort
    // is applied directly. A task spawned into a dying Lifetime starts cancelled
    // rather than running unowned.
    if (parentSignal.aborted) abort();

    // Disposal cannot reclassify a failure that has already happened.
    let cancelled = false;
    this.result = Promise.resolve().then(() => {
      try {
        return Promise.resolve(task(controller.signal)).catch((error: unknown) => {
          cancelled = isCancellationReason(controller.signal, error);
          throw error;
        });
      } catch (error) {
        cancelled = isCancellationReason(controller.signal, error);
        throw error;
      }
    });
    void this.result
      .then(
        () => this.#settle(),
        (error) => {
          try {
            if (!cancelled) report(error);
          } finally {
            this.#settle();
          }
        },
      )
      .catch((error) => report(error));
    Object.freeze(this);
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "settled") {
      return Promise.resolve();
    }
    const completion = this.result.then(
      () => undefined,
      () => undefined,
    );
    this.#state = { phase: "disposing", completion };
    state.controller.abort(disposalReason);
    this.#removeParentAbortListener();
    return completion;
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }

  #settle() {
    if (this.#state.phase === "settled") return;
    this.#state = { phase: "settled" };
    this.#removeParentAbortListener();
    const detach = this.#detachFromParent;
    this.#detachFromParent = undefined;
    detach?.(this);
  }

  #removeParentAbortListener() {
    const remove = this.#detachParentAbortListener;
    this.#detachParentAbortListener = undefined;
    remove?.();
  }
}

export class Lifetime implements LifetimeContext {
  #binding: LifetimeBinding | undefined;
  readonly #installationId: string;
  readonly #listeners: LifetimeResources<Publication>;
  readonly #contributions: LifetimeResources<Publication>;
  readonly #contributionViews: LifetimeResources<Disposable>;
  readonly #subscriptions: LifetimeResources<Disposable>;
  readonly #tasks: LifetimeResources<AsyncDisposable>;
  readonly #children = new Set<Lifetime>();
  readonly #label: string;
  readonly #cleanups: LifetimeResources<AsyncDisposable>;
  readonly #kind: "root" | "child";
  readonly #declarations: DeclarationPhase;
  #detachParentAbortListener: (() => void) | undefined;
  #detachFromParent: ((lifetime: Lifetime) => void) | undefined;
  readonly handle: LifetimeContext;
  #state: LifetimeState;

  constructor(port: LifetimePort, installationId: string, options: LifetimeOptions = {}) {
    this.#installationId = installationId;
    this.handle = new LifetimeHandle(this);
    const controller = new AbortController();
    this.#state = { phase: "active", controller };
    const parent = options.parent;
    this.#declarations = parent?.declarations ?? new DeclarationPhase();
    this.#detachFromParent = parent?.detach;
    this.#kind = parent ? "child" : "root";
    this.#label = parent?.label ?? installationId;
    const changed = () => this.#binding?.diagnostics.invalidate();
    this.#listeners = new LifetimeResources(changed);
    this.#contributions = new LifetimeResources(changed);
    this.#contributionViews = new LifetimeResources(changed);
    this.#subscriptions = new LifetimeResources(changed);
    this.#tasks = new LifetimeResources(changed);
    this.#cleanups = new LifetimeResources(changed);
    const diagnostics =
      parent?.diagnostics ??
      new SnapshotPublisher(
        () => this.#snapshot(),
        (error) => port.report(error),
      );
    this.#binding = { port, diagnostics };
    const parentSignal = options.parentSignal;
    if (!parentSignal) return;

    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#detachParentAbortListener = () => parentSignal.removeEventListener("abort", abort);
    if (parentSignal.aborted) abort();
  }

  get signal() {
    const state = this.#state;
    return state.phase === "disposed" ? state.signal : state.controller.signal;
  }

  get diagnostics() {
    return this.#requireBinding().diagnostics.view;
  }

  /** A facade whose only InstanceCoordinator edge disappears when this Lifetime terminates. */
  contextLogger(meta: InstanceMeta): Logger {
    const write =
      (level: keyof Logger) =>
      (message: unknown, ...details: unknown[]) =>
        this.#requireBinding().port.writeLog(level, message, meta, details);
    return Object.freeze({
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
    });
  }

  cleanup(dispose: Cleanup) {
    this.#requireActive();
    if (typeof dispose !== "function") throw new TypeError("Cleanup must be a function");
    const resource = new CleanupRecord(dispose, this.#cleanups.release);
    this.#cleanups.add(resource);
    return resource;
  }

  /**
   * A child scope. It inherits this Lifetime's signal, so cancellation flows
   * down, and its declaration phase, so a child created during `setup()` also
   * stages rather than publishing immediately.
   *
   * Disposing a child detaches it from both the resource set and the diagnostics
   * tree. A Plugin can therefore use child lifetimes as a unit of work — one per
   * open document, per connection — without the parent growing.
   */
  lifetime(label: string) {
    const { port, diagnostics } = this.#requireActive();
    validateLifetimeLabel(label);
    const child = new Lifetime(port, this.#installationId, {
      parentSignal: this.signal,
      parent: {
        diagnostics,
        label,
        declarations: this.#declarations,
        detach: (lifetime) => {
          if (this.#children.delete(lifetime)) diagnostics.invalidate();
        },
      },
    });
    this.#children.add(child);
    diagnostics.invalidate();
    return child.handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    const { port } = this.#requireActive();
    if (typeof task !== "function") throw new TypeError("Background task must be a function");
    const taskRecord = new TaskRecord(
      this.signal,
      task,
      (error) => port.report(error),
      this.#tasks.release,
    );
    this.#tasks.add(taskRecord);
    return taskRecord;
  }

  on<T>(token: Event<T>, listener: EventListener<T>) {
    const { port } = this.#requireActive();
    const publication = port.stageOn(token, listener, this.#listeners.release);
    this.#listeners.add(publication);
    if (this.#declarations.published) publication.publish();
    return publication.handle;
  }

  async emit<T>(token: Event<T>, ...payload: EventArguments<T>) {
    const { port } = this.#requireActive();
    await port.emit(token, payload[0] as T);
  }

  contribute<T>(token: ExtensionPoint<T>, key: string, value: T) {
    const { port } = this.#requireActive();
    const publication = port.stageContribution(
      this.#installationId,
      token,
      key,
      value,
      this.#contributions.release,
    );
    this.#contributions.add(publication);
    if (this.#declarations.published) publication.publish();
    return publication.handle;
  }

  /** Owns an internal live capability without exposing a second Context API. */
  ownLease(resource: Disposable, kind: ContributionLeaseKind) {
    this.#requireActive();
    const resources = kind === "view" ? this.#contributionViews : this.#subscriptions;
    return resources.own(resource);
  }

  /** Releases a temporary startup cancellation edge after its layer commits. */
  detachStartupSignal() {
    const remove = this.#detachParentAbortListener;
    this.#detachParentAbortListener = undefined;
    remove?.();
  }

  /**
   * Atomically makes everything staged during setup visible.
   *
   * Advancing the shared phase is the whole state change; the walk that follows
   * only flushes what each scope already staged. Called by the
   * InstanceCoordinator once the whole activation layer has succeeded — which is
   * what makes "no half-built Instance is observable" true.
   */
  publish() {
    this.#requireActive();
    if (this.#declarations.published) return;
    this.#declarations.publish();
    this.#flushStaged();
  }

  // Disposing a child scope during `setup()` is ordinary, and a child detaches
  // only once its own teardown has drained, so one can still be attached here.
  // It needs no special case: `dispose()` empties a scope's publication sets
  // synchronously, so a draining child contributes nothing to this walk.
  #flushStaged() {
    for (const publication of this.#listeners) publication.publish();
    for (const publication of this.#contributions) publication.publish();
    for (const child of this.#children) child.#flushStaged();
  }

  /**
   * Disposal is idempotent and joinable: concurrent callers share one completion
   * promise, so a Lifetime disposed by both its owner and a `using` block runs
   * its teardown once.
   *
   * The three-stage order is the module header's; see it for why. Errors from
   * every stage accumulate and are aggregated at the end, so one failing cleanup
   * neither hides the others nor prevents them from running.
   */
  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();

    const closing: LifetimeDisposal[] = [];
    const completion = this.#prepareDisposal(closing);
    // Phase and membership share one notification boundary; every callback reads
    // the sealed ownership tree after incoming capabilities have been withdrawn.
    batchSnapshotNotifications(() => {
      this.#requireBinding().diagnostics.invalidate();
      for (const { lifetime, errors } of closing) {
        lifetime.#listeners.disposeSynchronously(errors);
        lifetime.#subscriptions.disposeSynchronously(errors);
        lifetime.#contributionViews.disposeSynchronously(errors);
      }
      for (const { lifetime, errors } of closing) {
        lifetime.#contributions.disposeSynchronously(errors);
      }
    });
    for (const { lifetime, controller } of closing) {
      controller.abort(disposalReason);
      lifetime.detachStartupSignal();
    }
    for (const disposal of closing) disposal.finish();
    return completion;
  }

  /** Stages joinable completions without running any externally observable work. */
  #prepareDisposal(closing: LifetimeDisposal[]): Promise<void> {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();
    const binding = this.#requireBinding();
    const completion = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    this.#state = {
      phase: "disposing",
      controller: state.controller,
      completion: completion.promise,
    };
    // Observe child completions immediately, including failures that settle
    // while this parent's tasks are still draining. Descendants drain on their
    // own so a cancelling parent task may await child.dispose() without a cycle.
    const children = Promise.allSettled(
      [...this.#children].reverse().map((child) => child.#prepareDisposal(closing)),
    );
    const finish = () => {
      void (async () => {
        try {
          await this.#tasks.dispose(errors);
          for (const result of await children) {
            if (result.status === "rejected") errors.push(result.reason);
          }
          await this.#cleanups.dispose(errors);
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "Lifetime cleanup failed");
        } finally {
          this.#state = { phase: "disposed", signal: AbortSignal.abort(disposalReason) };
          const detach = this.#detachFromParent;
          this.#detachFromParent = undefined;
          try {
            detach?.(this);
            if (this.#kind === "root") {
              try {
                binding.diagnostics.invalidate();
              } finally {
                binding.diagnostics.dispose();
              }
            }
          } finally {
            this.#binding = undefined;
          }
        }
      })().then(completion.resolve, completion.reject);
    };
    closing.push({ lifetime: this, errors, controller: state.controller, finish });
    return completion.promise;
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }

  #snapshot(): LifetimeSnapshot {
    return Object.freeze({
      label: this.#label,
      phase: this.#state.phase,
      cleanups: this.#cleanups.size,
      tasks: this.#tasks.size,
      listeners: this.#listeners.size,
      contributions: this.#contributions.size,
      contributionViews: this.#contributionViews.size,
      subscriptions: this.#subscriptions.size,
      children: Object.freeze([...this.#children].map((child) => child.#snapshot())),
    });
  }

  // The gate on every operation that creates a resource. `signal.aborted` is
  // checked as well as the phase, because a parent's disposal aborts this signal
  // during startup cancellation as well as disposal. Both boundaries close work.
  #requireActive() {
    const binding = this.#binding;
    if (this.#state.phase !== "active" || this.signal.aborted || !binding) {
      throw lifetimeDisposedError();
    }
    return binding;
  }

  #requireBinding() {
    const binding = this.#binding;
    if (!binding) throw lifetimeDisposedError();
    return binding;
  }
}

type LifetimeState =
  | { readonly phase: "active"; readonly controller: AbortController }
  | {
      readonly phase: "disposing";
      readonly controller: AbortController;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed"; readonly signal: AbortSignal };

/**
 * What a Plugin actually receives. Forwarding only, and deliberately without
 * `publish()`, `ownLease()`, `detachStartupSignal()` or `diagnostics` — those
 * belong to whoever owns the Lifetime, not to the code running inside it.
 */
class LifetimeHandle implements LifetimeContext {
  readonly #lifetime: Lifetime;

  constructor(lifetime: Lifetime) {
    this.#lifetime = lifetime;
    Object.freeze(this);
  }

  get signal() {
    return this.#lifetime.signal;
  }

  cleanup(dispose: Cleanup) {
    return this.#lifetime.cleanup(dispose);
  }

  lifetime(label: string) {
    return this.#lifetime.lifetime(label);
  }

  spawn<T>(task: BackgroundTask<T>) {
    return this.#lifetime.spawn(task);
  }

  on<T>(token: Event<T>, listener: EventListener<T>) {
    return this.#lifetime.on(token, listener);
  }

  emit<T>(token: Event<T>, ...payload: EventArguments<T>) {
    return this.#lifetime.emit(token, ...payload);
  }

  contribute<T>(token: ExtensionPoint<T>, key: string, value: T) {
    return this.#lifetime.contribute(token, key, value);
  }

  dispose() {
    return this.#lifetime.dispose();
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }
}

function validateLifetimeLabel(label: string) {
  if (typeof label !== "string" || !label.trim()) {
    throw new TypeError("Lifetime label must be a non-empty string");
  }
  if (label !== label.trim()) {
    throw new TypeError("Lifetime label cannot start or end with whitespace");
  }
}

function lifetimeDisposedError() {
  return new DougongError("LIFETIME_DISPOSED", "Lifetime is disposing or has been disposed");
}
