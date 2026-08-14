import type { Event, Extension } from "./contracts";
import type { Contribution, ExtensionLeaseKind } from "./extension-store";
import type { EventListener } from "./event-hub";
import type { Disposable, Publication, StagedResource } from "./resource";
import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export interface Logger {
  debug(message: unknown, ...details: unknown[]): void;
  info(message: unknown, ...details: unknown[]): void;
  warn(message: unknown, ...details: unknown[]): void;
  error(message: unknown, ...details: unknown[]): void;
}

export interface PluginMeta {
  readonly app: string;
  readonly name: string;
  readonly instance: string;
  readonly group: string;
}

export interface Task<T = void> extends Disposable {
  readonly result: Promise<T>;
}

export type LifetimePhase = "active" | "disposing" | "disposed";

/** Live aggregate over one plugin's complete Lifetime tree. */
export interface LifetimeSnapshot {
  readonly phase: LifetimePhase;
  readonly cleanups: number;
  readonly tasks: number;
  readonly listeners: number;
  readonly contributions: number;
  readonly extensionViews: number;
  readonly subscriptions: number;
  readonly childLifetimes: number;
}

export type Cleanup = () => unknown;
export type BackgroundTask<T> = (signal: AbortSignal) => T | PromiseLike<T>;

export interface LifetimeOperations {
  readonly signal: AbortSignal;
  cleanup(dispose: Cleanup): Disposable;
  lifetime(): LifetimeContext;
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

type ResourceKind = Exclude<keyof LifetimeSnapshot, "phase">;

class LifetimeDiagnostics {
  readonly #counts: Record<ResourceKind, number> = {
    cleanups: 0,
    tasks: 0,
    listeners: 0,
    contributions: 0,
    extensionViews: 0,
    subscriptions: 0,
    childLifetimes: 0,
  };
  readonly #reporter: { report: ((error: unknown) => void) | undefined };
  readonly #source: SnapshotPublisher<LifetimeSnapshot>;
  #phase: LifetimePhase = "active";

  readonly view: SnapshotView<LifetimeSnapshot>;

  constructor(report: (error: unknown) => void) {
    this.#reporter = { report };
    this.#source = new SnapshotPublisher(
      () => this.#snapshot(),
      (error) => {
        this.#reporter.report?.(error);
      },
    );
    this.view = this.#source.view;
  }

  change(kind: ResourceKind, delta: 1 | -1) {
    this.#counts[kind] += delta;
    this.#source.invalidate();
  }

  beginDisposing() {
    if (this.#phase !== "active") return;
    this.#phase = "disposing";
    this.#source.invalidate();
  }

  finish() {
    if (this.#phase === "disposed") return;
    this.#phase = "disposed";
    this.#source.invalidate();
    // A retained historical diagnostic view must not retain the Application.
    this.#reporter.report = undefined;
  }

  #snapshot(): LifetimeSnapshot {
    return Object.freeze({ phase: this.#phase, ...this.#counts });
  }
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
  #removeParentListener: (() => void) | undefined;
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
    this.#removeParentListener = () => parentSignal.removeEventListener("abort", abort);
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
    this.#controller.abort();
    this.#removeParent();
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
    this.#removeParent();
    const detach = this.#detachFromParent;
    this.#detachFromParent = undefined;
    detach?.(this);
  }

  #removeParent() {
    const remove = this.#removeParentListener;
    this.#removeParentListener = undefined;
    remove?.();
  }
}

export class Lifetime implements LifetimeContext {
  #host: LifetimeHost | undefined;
  readonly #ownerId: string;
  readonly #controller = new AbortController();
  readonly #listeners = new Set<Publication>();
  readonly #contributions = new Set<Publication>();
  readonly #extensionViews = new Set<Disposable>();
  readonly #subscriptions = new Set<Disposable>();
  readonly #tasks = new Set<Disposable>();
  readonly #children = new Set<Lifetime>();
  readonly #resources = new Set<Disposable>();
  readonly #diagnosticModel: LifetimeDiagnostics;
  readonly #ownsDiagnostics: boolean;
  #removeParentListener: (() => void) | undefined;
  #detachFromParent: ((lifetime: Lifetime) => void) | undefined;
  readonly handle: LifetimeContext;
  #phase: LifetimePhase = "active";
  #published: boolean;
  #disposePromise: Promise<void> | undefined;

  constructor(
    host: LifetimeHost,
    ownerId: string,
    parentSignal?: AbortSignal,
    published = false,
    detachFromParent?: (lifetime: Lifetime) => void,
    diagnosticModel?: LifetimeDiagnostics,
  ) {
    this.#host = host;
    this.#ownerId = ownerId;
    this.handle = new LifetimeHandle(this);
    this.#published = published;
    this.#detachFromParent = detachFromParent;
    this.#ownsDiagnostics = diagnosticModel === undefined;
    this.#diagnosticModel =
      diagnosticModel ?? new LifetimeDiagnostics((error) => host.report(error));
    if (!parentSignal) return;

    const abort = () => this.#controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#removeParentListener = () => parentSignal.removeEventListener("abort", abort);
    if (parentSignal.aborted) abort();
  }

  get signal() {
    return this.#controller.signal;
  }

  get diagnostics() {
    return this.#diagnosticModel.view;
  }

  cleanup(dispose: Cleanup) {
    this.#assertActive();
    if (typeof dispose !== "function") throw new TypeError("Cleanup must be a function");
    const resource = new CleanupRecord(dispose, (item) => {
      this.#resources.delete(item);
      this.#diagnosticModel.change("cleanups", -1);
    });
    this.#resources.add(resource);
    this.#diagnosticModel.change("cleanups", 1);
    return resource;
  }

  lifetime() {
    this.#assertActive();
    const child = new Lifetime(
      this.#host!,
      this.#ownerId,
      this.signal,
      this.#published,
      (item) => {
        this.#children.delete(item);
        this.#diagnosticModel.change("childLifetimes", -1);
      },
      this.#diagnosticModel,
    );
    this.#children.add(child);
    this.#diagnosticModel.change("childLifetimes", 1);
    return child.handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    this.#assertActive();
    if (typeof task !== "function") throw new TypeError("Background task must be a function");
    let record!: TaskRecord<T>;
    record = new TaskRecord(
      this.signal,
      task,
      (error) => this.#host!.report(error),
      (item) => {
        this.#tasks.delete(item);
        this.#diagnosticModel.change("tasks", -1);
      },
    );
    this.#tasks.add(record);
    this.#diagnosticModel.change("tasks", 1);
    return record;
  }

  on<T>(token: Event<T>, listener: EventListener<T>) {
    this.#assertActive();
    const publication = this.#host!.stageOn(this.#ownerId, token, listener, (item) => {
      this.#listeners.delete(item);
      this.#diagnosticModel.change("listeners", -1);
    });
    this.#listeners.add(publication);
    this.#diagnosticModel.change("listeners", 1);
    if (this.#published) publication.publish();
    return publication.handle;
  }

  emit<T>(token: Event<T>, payload: T) {
    this.#assertActive();
    return this.#host!.emit(this.#ownerId, token, payload);
  }

  contribute<T>(token: Extension<T>, key: string, value: T) {
    this.#assertActive();
    const publication = this.#host!.stageContribution(this.#ownerId, token, key, value, (item) => {
      this.#contributions.delete(item);
      this.#diagnosticModel.change("contributions", -1);
    });
    this.#contributions.add(publication);
    this.#diagnosticModel.change("contributions", 1);
    if (this.#published) publication.publish();
    return publication.handle;
  }

  /** Owns an internal live capability without exposing a second Context API. */
  ownLease(resource: Disposable, kind: ExtensionLeaseKind) {
    this.#assertActive();
    const resources = kind === "view" ? this.#extensionViews : this.#subscriptions;
    const diagnosticKind = kind === "view" ? "extensionViews" : "subscriptions";
    resources.add(resource);
    this.#diagnosticModel.change(diagnosticKind, 1);
    let owned = true;
    return () => {
      if (!owned) return;
      owned = false;
      resources.delete(resource);
      this.#diagnosticModel.change(diagnosticKind, -1);
    };
  }

  /** Releases a temporary startup cancellation edge after its layer commits. */
  detachParentSignal() {
    const remove = this.#removeParentListener;
    this.#removeParentListener = undefined;
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
    if (this.#ownsDiagnostics) this.#diagnosticModel.beginDisposing();

    // Reject new work and withdraw public capabilities before cancellation or
    // user cleanup. This ordering is invariant, not registration-order luck.
    this.#disposePromise = (async () => {
      const errors: unknown[] = [];
      await disposeOwned(this.#listeners, errors);
      await disposeOwned(this.#contributions, errors);
      await disposeOwned(this.#subscriptions, errors);
      await disposeOwned(this.#extensionViews, errors);

      this.#controller.abort();
      this.detachParentSignal();

      await disposeOwned(this.#tasks, errors);
      await disposeOwned(this.#children, errors);
      await disposeOwned(this.#resources, errors);

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Lifetime cleanup failed");
    })().finally(() => {
      this.#phase = "disposed";
      this.#host = undefined;
      const detach = this.#detachFromParent;
      this.#detachFromParent = undefined;
      detach?.(this);
      if (this.#ownsDiagnostics) this.#diagnosticModel.finish();
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

  lifetime() {
    return this.#lifetime.lifetime();
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

async function disposeAll<T extends Disposable>(resources: ReadonlyArray<T>, errors: unknown[]) {
  for (const resource of resources) {
    try {
      await resource.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
}

async function disposeOwned<T extends Disposable>(resources: Set<T>, errors: unknown[]) {
  const owned = [...resources].reverse();
  resources.clear();
  await disposeAll(owned, errors);
}
