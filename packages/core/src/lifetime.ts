// Withdraw capabilities before cancellation to stop incoming work; cancel before awaiting to unblock tasks.

import { normalizeContract, type Event, type ExtensionPoint } from "./contracts";
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

// Hostile logger getters must fail validation without escaping the recognition boundary.
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

// Use one reason object so cancellation attribution does not rely solely on the AbortError name.
const disposalReason = Object.freeze(new DOMException("Resource disposed", "AbortError"));

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

// The root owns declaration visibility so child scopes cannot advance competing publication phases.
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

  // Later resources may depend on earlier ones; failed teardown must not strand siblings.
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

  // Capability withdrawal must finish without yielding to callbacks or tasks.
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

// Detach settled tasks and abort listeners to avoid retention. Background failures need the owner error sink.
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
    // An already-aborted parent will never fire a new abort listener.
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

  // Children share declaration visibility so setup cannot publish only part of one Instance.
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
    this.#requireActive();
    const identity = normalizeContract(token, "event");
    const { port } = this.#requireActive();
    const publication = port.stageOn(identity, listener, this.#listeners.release);
    this.#listeners.add(publication);
    if (this.#declarations.published) publication.publish();
    return publication.handle;
  }

  async emit<T>(token: Event<T>, ...payload: EventArguments<T>) {
    this.#requireActive();
    const identity = normalizeContract(token, "event");
    const { port } = this.#requireActive();
    await port.emit(identity, payload[0] as T);
  }

  contribute<T>(token: ExtensionPoint<T>, key: string, value: T) {
    this.#requireActive();
    const identity = normalizeContract(token, "extensionPoint");
    const { port } = this.#requireActive();
    const publication = port.stageContribution(
      this.#installationId,
      identity,
      key,
      value,
      this.#contributions.release,
    );
    this.#contributions.add(publication);
    if (this.#declarations.published) publication.publish();
    return publication.handle;
  }

  ownLease(resource: Disposable, kind: ContributionLeaseKind) {
    this.#requireActive();
    const resources = kind === "view" ? this.#contributionViews : this.#subscriptions;
    return resources.own(resource);
  }

  detachStartupSignal() {
    const remove = this.#detachParentAbortListener;
    this.#detachParentAbortListener = undefined;
    remove?.();
  }

  // Advance the shared phase before flushing scopes so callbacks cannot observe mixed publication states.
  publish() {
    this.#requireActive();
    if (this.#declarations.published) return;
    this.#declarations.publish();
    this.#flushStaged();
  }

  // Disposing children stay attached until teardown settles; flushing must tolerate revoked publications.
  #flushStaged() {
    for (const publication of this.#listeners) publication.publish();
    for (const publication of this.#contributions) publication.publish();
    for (const child of this.#children) child.#flushStaged();
  }

  // Join disposal to run teardown once; aggregate failures so one cleanup cannot hide or prevent another.
  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();

    const closing: LifetimeDisposal[] = [];
    const completion = this.#prepareDisposal(closing);
    // Notify only after sealing membership so callbacks cannot observe a partially sealed ownership tree.
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
    // Observe child failures before awaiting parent tasks so fast rejections cannot escape ownership.
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

  // Parent cancellation can arrive before local disposal, so resource creation also checks the signal.
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

// The Plugin facade omits publication and diagnostic capabilities reserved for the Lifetime owner.
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
