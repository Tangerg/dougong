import type { Event, Extension } from "./contracts";
import type { Contribution, ExtensionLeaseKind } from "./extension-store";
import type { EventListener } from "./event-hub";
import {
  LifetimeDiagnostics,
  type LifetimeDiagnosticNode,
  type LifetimePhase,
  type LifetimeResourceKind,
} from "./lifetime-diagnostics";
import type { Disposable, Publication, StagedResource } from "./resource";

export type { LifetimePhase, LifetimeSnapshot } from "./lifetime-diagnostics";

export interface Logger {
  debug(message: unknown, ...details: unknown[]): void;
  info(message: unknown, ...details: unknown[]): void;
  warn(message: unknown, ...details: unknown[]): void;
  error(message: unknown, ...details: unknown[]): void;
}

export interface PluginMeta {
  readonly applicationName: string;
  readonly pluginName: string;
  readonly installationId: string;
  readonly groupId: string;
}

export interface Task<T = void> extends Disposable {
  readonly result: Promise<T>;
}

export type Cleanup = () => unknown;
export type BackgroundTask<T> = (signal: AbortSignal) => T | PromiseLike<T>;

const disposalReason = Object.freeze(new DOMException("Resource disposed", "AbortError"));

export interface LifetimeOperations {
  readonly signal: AbortSignal;
  cleanup(dispose: Cleanup): Disposable;
  lifetime(label: string): LifetimeContext;
  spawn<T>(task: BackgroundTask<T>): Task<T>;
  on<T>(token: Event<T>, listener: EventListener<T>): Disposable;
  emit<T>(token: Event<T>, payload: T): Promise<void>;
  contribute<T>(token: Extension<T>, key: string, value: T): Contribution<T>;
}

export interface LifetimeContext extends LifetimeOperations, Disposable {}

export interface LifetimeHost {
  stageOn<T>(
    ownerId: string,
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
  ): StagedResource<Disposable>;
  emit<T>(ownerId: string, token: Event<T>, payload: T): Promise<void>;
  stageContribution<T>(
    ownerId: string,
    token: Extension<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
  ): StagedResource<Contribution<T>>;
  report(error: unknown): void;
}

interface LifetimeOptions {
  readonly parentSignal?: AbortSignal;
  readonly published?: boolean;
  readonly detachFromParent?: (lifetime: Lifetime) => void;
  readonly diagnostics?: LifetimeDiagnostics;
  readonly diagnosticNode?: LifetimeDiagnosticNode;
}

/** One canonical owner for O(1) terminal detachment and diagnostic accounting. */
class LifetimeResources<T extends Disposable> implements Iterable<T> {
  readonly #resources = new Set<T>();
  #accounting: LifetimeResourceAccounting | undefined;

  constructor(accounting?: LifetimeResourceAccounting) {
    this.#accounting = accounting;
  }

  add(resource: T) {
    if (this.#resources.has(resource)) throw new TypeError("Lifetime already owns this resource");
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

class CleanupRecord implements Disposable {
  #cleanup: Cleanup | undefined;
  #detachFromParent: ((resource: Disposable) => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(cleanup: Cleanup, detachFromParent: (resource: Disposable) => void) {
    this.#cleanup = cleanup;
    this.#detachFromParent = detachFromParent;
    Object.freeze(this);
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      const cleanup = this.#cleanup;
      this.#cleanup = undefined;
      try {
        await cleanup?.();
      } finally {
        const detach = this.#detachFromParent;
        this.#detachFromParent = undefined;
        detach?.(this);
      }
    })();
    return this.#disposePromise;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }
}

class TaskRecord<T> implements Task<T> {
  readonly #controller = new AbortController();
  #detachParentAbortListener: (() => void) | undefined;
  #detachFromParent: ((task: Disposable) => void) | undefined;
  #settled = false;
  #disposePromise: Promise<void> | undefined;
  readonly result: Promise<T>;

  constructor(
    parentSignal: AbortSignal,
    task: BackgroundTask<T>,
    report: (error: unknown) => void,
    detachFromParent: (task: Disposable) => void,
  ) {
    const abort = () => this.#controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#detachParentAbortListener = () => parentSignal.removeEventListener("abort", abort);
    this.#detachFromParent = detachFromParent;
    if (parentSignal.aborted) abort();

    this.result = Promise.resolve().then(() => task(this.#controller.signal));
    void this.result
      .then(
        () => this.#settle(),
        (error) => {
          try {
            if (!this.#controller.signal.aborted) report(error);
          } finally {
            this.#settle();
          }
        },
      )
      .catch(() => undefined);
    Object.freeze(this);
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#settled) {
      this.#disposePromise = Promise.resolve();
      return this.#disposePromise;
    }
    this.#controller.abort(disposalReason);
    this.#removeParentAbortListener();
    this.#disposePromise = this.result.then(
      () => undefined,
      () => undefined,
    );
    return this.#disposePromise;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }

  #settle() {
    if (this.#settled) return;
    this.#settled = true;
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
  #host: LifetimeHost | undefined;
  readonly #ownerId: string;
  readonly #controller = new AbortController();
  readonly #listeners: LifetimeResources<Publication>;
  readonly #contributions: LifetimeResources<Publication>;
  readonly #extensionViews: LifetimeResources<Disposable>;
  readonly #subscriptions: LifetimeResources<Disposable>;
  readonly #tasks: LifetimeResources<Disposable>;
  readonly #children: LifetimeResources<Lifetime>;
  readonly #cleanups: LifetimeResources<Disposable>;
  #diagnostics: LifetimeDiagnostics | undefined;
  #diagnosticNode: LifetimeDiagnosticNode | undefined;
  readonly #isRoot: boolean;
  #detachParentAbortListener: (() => void) | undefined;
  #detachFromParent: ((lifetime: Lifetime) => void) | undefined;
  readonly handle: LifetimeContext;
  #phase: LifetimePhase = "active";
  #published: boolean;
  #disposePromise: Promise<void> | undefined;

  constructor(host: LifetimeHost, ownerId: string, options: LifetimeOptions = {}) {
    this.#host = host;
    this.#ownerId = ownerId;
    this.handle = new LifetimeHandle(this);
    this.#published = options.published ?? false;
    this.#detachFromParent = options.detachFromParent;
    this.#isRoot = options.diagnostics === undefined;
    const diagnostics =
      options.diagnostics ?? new LifetimeDiagnostics(ownerId, (error) => host.report(error));
    const diagnosticNode = options.diagnosticNode ?? diagnostics.root;
    this.#diagnostics = diagnostics;
    this.#diagnosticNode = diagnosticNode;
    const account = (kind: LifetimeResourceKind): LifetimeResourceAccounting => ({
      diagnostics,
      node: diagnosticNode,
      kind,
    });
    this.#listeners = new LifetimeResources(account("listeners"));
    this.#contributions = new LifetimeResources(account("contributions"));
    this.#extensionViews = new LifetimeResources(account("extensionViews"));
    this.#subscriptions = new LifetimeResources(account("subscriptions"));
    this.#tasks = new LifetimeResources(account("tasks"));
    this.#children = new LifetimeResources();
    this.#cleanups = new LifetimeResources(account("cleanups"));
    const parentSignal = options.parentSignal;
    if (!parentSignal) return;

    const abort = () => this.#controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#detachParentAbortListener = () => parentSignal.removeEventListener("abort", abort);
    if (parentSignal.aborted) abort();
  }

  get signal() {
    return this.#controller.signal;
  }

  get diagnostics() {
    return this.#requireDiagnostics().view;
  }

  cleanup(dispose: Cleanup) {
    this.#assertActive();
    if (typeof dispose !== "function") throw new TypeError("Cleanup must be a function");
    const resource = new CleanupRecord(dispose, this.#cleanups.release);
    this.#cleanups.add(resource);
    return resource;
  }

  lifetime(label: string) {
    this.#assertActive();
    validateLifetimeLabel(label);
    const host = this.#requireHost();
    const diagnostics = this.#requireDiagnostics();
    const parentNode = this.#requireDiagnosticNode();
    const diagnosticNode = diagnostics.createNode(label);
    const child = new Lifetime(host, this.#ownerId, {
      parentSignal: this.signal,
      published: this.#published,
      diagnostics,
      diagnosticNode,
      detachFromParent: (lifetime) => {
        if (!this.#children.release(lifetime)) return;
        diagnostics.detach(parentNode, diagnosticNode);
      },
    });
    this.#children.add(child);
    diagnostics.attach(parentNode, diagnosticNode);
    return child.handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    this.#assertActive();
    if (typeof task !== "function") throw new TypeError("Background task must be a function");
    const host = this.#requireHost();
    const taskRecord = new TaskRecord(
      this.signal,
      task,
      (error) => host.report(error),
      this.#tasks.release,
    );
    this.#tasks.add(taskRecord);
    return taskRecord;
  }

  on<T>(token: Event<T>, listener: EventListener<T>) {
    this.#assertActive();
    const publication = this.#requireHost().stageOn(
      this.#ownerId,
      token,
      listener,
      this.#listeners.release,
    );
    this.#listeners.add(publication);
    if (this.#published) publication.publish();
    return publication.handle;
  }

  emit<T>(token: Event<T>, payload: T) {
    this.#assertActive();
    return this.#requireHost().emit(this.#ownerId, token, payload);
  }

  contribute<T>(token: Extension<T>, key: string, value: T) {
    this.#assertActive();
    const publication = this.#requireHost().stageContribution(
      this.#ownerId,
      token,
      key,
      value,
      this.#contributions.release,
    );
    this.#contributions.add(publication);
    if (this.#published) publication.publish();
    return publication.handle;
  }

  /** Owns an internal live capability without exposing a second Context API. */
  ownLease(resource: Disposable, kind: ExtensionLeaseKind) {
    this.#assertActive();
    const resources = kind === "view" ? this.#extensionViews : this.#subscriptions;
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
    this.#assertActive();
    if (this.#published) return;
    for (const publication of this.#listeners) publication.publish();
    for (const publication of this.#contributions) publication.publish();
    for (const child of this.#children) child.publish();
    this.#published = true;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#phase = "disposing";
    const diagnostics = this.#requireDiagnostics();
    diagnostics.beginDisposing(this.#requireDiagnosticNode());

    // Reject new work and withdraw public capabilities before cancellation or
    // user cleanup. This ordering is invariant, not registration-order luck.
    this.#disposePromise = (async () => {
      const errors: unknown[] = [];
      await this.#listeners.dispose(errors);
      await this.#contributions.dispose(errors);
      await this.#subscriptions.dispose(errors);
      await this.#extensionViews.dispose(errors);

      this.#controller.abort(disposalReason);
      this.detachStartupSignal();

      await this.#tasks.dispose(errors);
      await this.#children.dispose(errors);
      await this.#cleanups.dispose(errors);

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Lifetime cleanup failed");
    })().finally(() => {
      this.#phase = "disposed";
      this.#host = undefined;
      const detach = this.#detachFromParent;
      this.#detachFromParent = undefined;
      try {
        detach?.(this);
        if (this.#isRoot) diagnostics.finishRoot();
      } finally {
        this.#diagnostics = undefined;
        this.#diagnosticNode = undefined;
      }
    });
    return this.#disposePromise;
  }

  [Symbol.asyncDispose]() {
    return this.dispose();
  }

  #assertActive() {
    if (this.#phase !== "active" || this.signal.aborted) {
      throw new TypeError("Lifetime is disposing or has been disposed");
    }
  }

  #requireHost() {
    const host = this.#host;
    if (!host) throw new TypeError("Lifetime is disposing or has been disposed");
    return host;
  }

  #requireDiagnostics() {
    const diagnostics = this.#diagnostics;
    if (!diagnostics) throw new TypeError("Lifetime is disposing or has been disposed");
    return diagnostics;
  }

  #requireDiagnosticNode() {
    const node = this.#diagnosticNode;
    if (!node) throw new TypeError("Lifetime is disposing or has been disposed");
    return node;
  }
}

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

  emit<T>(token: Event<T>, payload: T) {
    return this.#lifetime.emit(token, payload);
  }

  contribute<T>(token: Extension<T>, key: string, value: T) {
    return this.#lifetime.contribute(token, key, value);
  }

  dispose() {
    return this.#lifetime.dispose();
  }

  [Symbol.asyncDispose]() {
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
