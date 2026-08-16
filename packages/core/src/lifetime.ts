import type { Event, ExtensionPoint } from "./contracts";
import type { Contribution, ContributionLeaseKind } from "./contribution-store";
import { DougongError, isCancellationReason } from "./errors";
import type { EventListener } from "./event-hub";
import {
  LifetimeDiagnostics,
  type LifetimeDiagnosticNode,
  type LifetimeResourceKind,
} from "./lifetime-diagnostics";
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

export function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Logger>;
  return [candidate.debug, candidate.info, candidate.warn, candidate.error].every(
    (method) => typeof method === "function",
  );
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

const disposalReason = Object.freeze(new DOMException("Resource disposed", "AbortError"));

export interface LifetimeOperations {
  readonly signal: AbortSignal;
  cleanup(dispose: Cleanup): AsyncDisposable;
  lifetime(label: string): LifetimeContext;
  spawn<T>(task: BackgroundTask<T>): Task<T>;
  on<T>(token: Event<T>, listener: EventListener<T>): Disposable;
  emit<T>(token: Event<T>, ...payload: EventArguments<T>): Promise<void>;
  contribute<T>(token: ExtensionPoint<T>, key: string, value: T): Contribution<T>;
}

export interface LifetimeContext extends LifetimeOperations, AsyncDisposable {}

export interface LifetimePort {
  stageOn<T>(
    ownerId: string,
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ): StagedResource<Disposable>;
  emit<T>(ownerId: string, token: Event<T>, payload: T): Promise<void>;
  stageContribution<T>(
    ownerId: string,
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ): StagedResource<Contribution<T>>;
  writeLog(
    level: keyof Logger,
    message: unknown,
    meta: InstanceMeta,
    details: readonly unknown[],
  ): void;
  report(error: unknown): void;
}

interface LifetimeOptions {
  readonly parentSignal?: AbortSignal;
  readonly declarations?: "staged" | "published";
  readonly parent?: {
    readonly detach: (lifetime: Lifetime) => void;
    readonly diagnostics: LifetimeDiagnostics;
    readonly diagnosticNode: LifetimeDiagnosticNode;
  };
}

interface LifetimeBinding {
  readonly port: LifetimePort;
  readonly diagnostics: LifetimeDiagnostics;
  readonly diagnosticNode: LifetimeDiagnosticNode;
}

/** One canonical owner for O(1) terminal detachment and diagnostic accounting. */
class LifetimeResources<T extends Resource> implements Iterable<T> {
  readonly #resources = new Set<T>();
  #accounting: LifetimeResourceAccounting | undefined;

  constructor(accounting?: LifetimeResourceAccounting) {
    this.#accounting = accounting;
  }

  add(resource: T) {
    if (this.#resources.has(resource)) throw new Error("Lifetime already owns this resource");
    this.#resources.add(resource);
    const accounting = this.#accounting;
    if (accounting) accounting.diagnostics.change(accounting.node, accounting.kind, 1);
  }

  own(resource: T) {
    this.add(resource);
    return () => this.release(resource);
  }

  readonly release = (resource: T) => {
    if (!this.#resources.delete(resource)) return false;
    const accounting = this.#accounting;
    if (accounting) accounting.diagnostics.change(accounting.node, accounting.kind, -1);
    return true;
  };

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
      this.#accounting = undefined;
    }
  }

  [Symbol.iterator]() {
    return this.#resources[Symbol.iterator]();
  }
}

interface LifetimeResourceAccounting {
  readonly diagnostics: LifetimeDiagnostics;
  readonly node: LifetimeDiagnosticNode;
  readonly kind: LifetimeResourceKind;
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
    if (parentSignal.aborted) abort();

    this.result = Promise.resolve().then(() => task(controller.signal));
    void this.result
      .then(
        () => this.#settle(),
        (error) => {
          try {
            if (!isCancellationReason(controller.signal, error)) report(error);
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
  readonly #ownerId: string;
  readonly #listeners: LifetimeResources<Publication>;
  readonly #contributions: LifetimeResources<Publication>;
  readonly #contributionViews: LifetimeResources<Disposable>;
  readonly #subscriptions: LifetimeResources<Disposable>;
  readonly #tasks: LifetimeResources<AsyncDisposable>;
  readonly #children: LifetimeResources<Lifetime>;
  readonly #cleanups: LifetimeResources<AsyncDisposable>;
  readonly #kind: "root" | "child";
  #detachParentAbortListener: (() => void) | undefined;
  #detachFromParent: ((lifetime: Lifetime) => void) | undefined;
  readonly handle: LifetimeContext;
  #state: LifetimeState;

  constructor(port: LifetimePort, ownerId: string, options: LifetimeOptions = {}) {
    this.#ownerId = ownerId;
    this.handle = new LifetimeHandle(this);
    const controller = new AbortController();
    this.#state = {
      phase: "active",
      controller,
      declarations: options.declarations ?? "staged",
    };
    const parent = options.parent;
    this.#detachFromParent = parent?.detach;
    this.#kind = parent ? "child" : "root";
    const diagnostics =
      parent?.diagnostics ?? new LifetimeDiagnostics(ownerId, (error) => port.report(error));
    const diagnosticNode = parent?.diagnosticNode ?? diagnostics.root;
    this.#binding = { port, diagnostics, diagnosticNode };
    const account = (kind: LifetimeResourceKind): LifetimeResourceAccounting => ({
      diagnostics,
      node: diagnosticNode,
      kind,
    });
    this.#listeners = new LifetimeResources(account("listeners"));
    this.#contributions = new LifetimeResources(account("contributions"));
    this.#contributionViews = new LifetimeResources(account("contributionViews"));
    this.#subscriptions = new LifetimeResources(account("subscriptions"));
    this.#tasks = new LifetimeResources(account("tasks"));
    this.#children = new LifetimeResources();
    this.#cleanups = new LifetimeResources(account("cleanups"));
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
    return this.#requireActive().diagnostics.view;
  }

  /** A facade whose only Runtime edge disappears when this Lifetime terminates. */
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

  lifetime(label: string) {
    const { port, diagnostics, diagnosticNode: parentNode } = this.#requireActive();
    validateLifetimeLabel(label);
    const diagnosticNode = diagnostics.createNode(label);
    const child = new Lifetime(port, this.#ownerId, {
      parentSignal: this.signal,
      declarations: this.#declarations(),
      parent: {
        diagnostics,
        diagnosticNode,
        detach: (lifetime) => {
          if (!this.#children.release(lifetime)) return;
          diagnostics.detach(parentNode, diagnosticNode);
        },
      },
    });
    this.#children.add(child);
    diagnostics.attach(parentNode, diagnosticNode);
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
    const publication = port.stageOn(this.#ownerId, token, listener, this.#listeners.release);
    this.#listeners.add(publication);
    if (this.#declarations() === "published") publication.publish();
    return publication.handle;
  }

  async emit<T>(token: Event<T>, ...payload: EventArguments<T>) {
    const { port } = this.#requireActive();
    await port.emit(this.#ownerId, token, payload[0] as T);
  }

  contribute<T>(token: ExtensionPoint<T>, key: string, value: T) {
    const { port } = this.#requireActive();
    const publication = port.stageContribution(
      this.#ownerId,
      token,
      key,
      value,
      this.#contributions.release,
    );
    this.#contributions.add(publication);
    if (this.#declarations() === "published") publication.publish();
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

  /** Atomically makes all declarations staged during setup visible. */
  publish() {
    const state = this.#state;
    if (state.phase !== "active") throw lifetimeDisposedError();
    this.#requireActive();
    if (state.declarations === "published") return;
    for (const publication of this.#listeners) publication.publish();
    for (const publication of this.#contributions) publication.publish();
    for (const child of this.#children) child.publish();
    this.#state = { ...state, declarations: "published" };
  }

  dispose() {
    const state = this.#state;
    if (state.phase === "disposing") return state.completion;
    if (state.phase === "disposed") return Promise.resolve();
    const binding = this.#requireBinding();
    const completion = Promise.resolve()
      .then(async () => {
        const errors: unknown[] = [];
        await this.#listeners.dispose(errors);
        await this.#contributions.dispose(errors);
        await this.#subscriptions.dispose(errors);
        await this.#contributionViews.dispose(errors);

        state.controller.abort(disposalReason);
        this.detachStartupSignal();

        await this.#tasks.dispose(errors);
        await this.#children.dispose(errors);
        await this.#cleanups.dispose(errors);

        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Lifetime cleanup failed");
      })
      .finally(() => {
        this.#state = { phase: "disposed", signal: AbortSignal.abort(disposalReason) };
        const detach = this.#detachFromParent;
        this.#detachFromParent = undefined;
        try {
          detach?.(this);
          if (this.#kind === "root") binding.diagnostics.finishRoot();
        } finally {
          this.#binding = undefined;
        }
      });
    this.#state = { phase: "disposing", controller: state.controller, completion };
    binding.diagnostics.beginDisposing(binding.diagnosticNode);

    // Reject new work before withdrawing capabilities, cancellation or user
    // cleanup. The completion is already published so reentrant disposal joins it.
    return completion;
  }

  [asyncDisposeSymbol]() {
    return this.dispose();
  }

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

  #declarations() {
    const state = this.#state;
    if (state.phase !== "active") throw lifetimeDisposedError();
    return state.declarations;
  }
}

type LifetimeState =
  | {
      readonly phase: "active";
      readonly controller: AbortController;
      readonly declarations: "staged" | "published";
    }
  | {
      readonly phase: "disposing";
      readonly controller: AbortController;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "disposed"; readonly signal: AbortSignal };

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
