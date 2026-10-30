import { DougongError, isCancellationReason, RecordedFailure } from "../contracts/errors.js";
import { assertSynchronous } from "../internal/sync-result.js";
import { batchSnapshotNotifications } from "../observation/snapshot-view.js";
import type {
  LifetimePhase,
  LifetimeSnapshot,
  ObligationKind,
  UnresolvedObligation,
} from "./lifetime-diagnostics.js";
import {
  asyncDisposeSymbol,
  captureDisposer,
  disposeSymbol,
  type AsyncDisposable,
  type Awaitable,
  type Disposable,
  type Publication,
  type Resource,
} from "../contracts/resource.js";

export type {
  LifetimePhase,
  LifetimeSnapshot,
  UnresolvedObligation,
} from "./lifetime-diagnostics.js";

export interface Task<T = void> extends AsyncDisposable {
  readonly result: Promise<T>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type Cleanup = () => Awaitable<unknown>;
export type BackgroundTask<T> = (signal: AbortSignal) => Awaitable<T>;

export interface LifetimeContext extends AsyncDisposable {
  readonly signal: AbortSignal;
  readonly use: <T extends Resource>(resource: T) => T;
  readonly defer: (cleanup: Cleanup) => AsyncDisposable;
  readonly child: (label: string) => LifetimeContext;
  readonly spawn: <T>(task: BackgroundTask<T>) => Task<T>;
  readonly acquire: <T extends Resource>(
    factory: (signal: AbortSignal) => Awaitable<T>,
  ) => Promise<T>;
  readonly interrupt: (callback: Cleanup) => Disposable;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LifetimeOwnership {
  readonly lifetime?: LifetimeContext;
}

const lifetimeAuthorities = new WeakMap<LifetimeContext, Lifetime>();

export interface LifetimeOptions {
  readonly label: string;
  readonly report: (error: unknown) => void;
  readonly changed?: () => void;
  readonly parentSignal?: AbortSignal;
  readonly shutdownTimeoutMs?: number;
}

interface ChildOwnership {
  readonly visibility: Visibility;
  readonly detach: (child: Lifetime) => void;
}

class Visibility {
  published = false;
}

const disposalReason = Object.freeze(new DOMException("Resource disposed", "AbortError"));
const disposedSignal = AbortSignal.abort(disposalReason);

class CleanupRecord {
  readonly id: number;
  readonly kind: "cleanup" | "interrupt";
  #cleanup: Cleanup | undefined;
  #detach: (() => void) | undefined;
  #completion: Promise<void> | undefined;
  #failure: RecordedFailure | undefined;
  #changed: (() => void) | undefined;

  constructor(
    id: number,
    kind: "cleanup" | "interrupt",
    cleanup: Cleanup,
    detach: () => void,
    changed: () => void,
  ) {
    this.#changed = changed;
    this.id = id;
    this.kind = kind;
    this.#cleanup = cleanup;
    this.#detach = detach;
  }

  get failure() {
    return this.#failure;
  }

  dispose(): Promise<void> {
    if (this.#completion) return this.#completion;
    const cleanup = this.#cleanup;
    if (!cleanup) return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    this.#completion = completion.promise;
    void Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          this.#cleanup = undefined;
          const detach = this.#detach;
          this.#detach = undefined;
          this.#changed = undefined;
          detach?.();
          completion.resolve();
        },
        (error) => {
          // A failed release still belongs to this record; retrying an arbitrary callback is unsafe.
          this.#failure = new RecordedFailure(error);
          this.#changed?.();
          completion.reject(error);
        },
      );
    return completion.promise;
  }

  forget() {
    if (this.#completion) return;
    this.#cleanup = undefined;
    this.#changed = undefined;
    const detach = this.#detach;
    this.#detach = undefined;
    detach?.();
  }
}

class PublicationRecord {
  readonly id: number;
  readonly publication: Publication;
  failure: RecordedFailure | undefined;

  constructor(id: number, publication: Publication) {
    this.id = id;
    this.publication = publication;
  }

  withdraw() {
    if (this.failure) throw this.failure;
    try {
      assertSynchronous(
        this.publication[disposeSymbol](),
        "Publication withdrawal must be synchronous",
      );
    } catch (error) {
      this.failure = new RecordedFailure(error);
      throw error;
    }
  }
}

class TaskRecord<T> implements Task<T> {
  readonly result: Promise<T>;
  #controller: AbortController | undefined;
  #detachAbort: (() => void) | undefined;
  #detach: (() => void) | undefined;
  #completion: Promise<void> | undefined;

  constructor(
    parentSignal: AbortSignal,
    task: BackgroundTask<T>,
    report: ((error: unknown) => void) | undefined,
    detach: () => void,
  ) {
    const controller = new AbortController();
    this.#controller = controller;
    this.#detach = detach;
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#detachAbort = () => parentSignal.removeEventListener("abort", abort);
    if (parentSignal.aborted) abort();
    const result = Promise.withResolvers<T>();
    this.result = result.promise;
    // Observe owned work even when its caller does not await the public result.
    void this.result.catch(() => undefined);
    const fail = (error: unknown) => {
      try {
        if (report && !isCancellationReason(controller.signal, error)) report(error);
      } catch (reporterError) {
        queueMicrotask(() => {
          throw reporterError;
        });
      } finally {
        this.#settle();
        result.reject(error);
      }
    };
    void Promise.resolve().then(() => {
      let output: Awaitable<T>;
      try {
        output = task(controller.signal);
      } catch (error) {
        fail(error);
        return;
      }
      void Promise.resolve(output).then((value) => {
        this.#settle();
        result.resolve(value);
      }, fail);
    });
    Object.freeze(this);
  }

  #settle() {
    this.#controller = undefined;
    this.#detachAbort?.();
    this.#detachAbort = undefined;
    const detach = this.#detach;
    this.#detach = undefined;
    detach?.();
  }

  [asyncDisposeSymbol](): Promise<void> {
    if (this.#completion) return this.#completion;
    const completion = this.result.then(
      () => undefined,
      () => undefined,
    );
    this.#completion = completion;
    this.#controller?.abort(disposalReason);
    this.#detachAbort?.();
    this.#detachAbort = undefined;
    return completion;
  }
}

export class Lifetime {
  readonly #label: string;
  #controller: AbortController | undefined = new AbortController();
  readonly #visibility: Visibility;
  readonly #children = new Set<Lifetime>();
  readonly #cleanups = new Set<CleanupRecord>();
  readonly #interrupts = new Set<CleanupRecord>();
  readonly #publications = new Set<PublicationRecord>();
  readonly #tasks = new Set<TaskRecord<unknown>>();
  readonly #acquisitions = new Set<Promise<unknown>>();
  readonly #shutdownTimeoutMs: number | undefined;
  #report: ((error: unknown) => void) | undefined;
  #changed: (() => void) | undefined;
  #phase: LifetimePhase = "active";
  #foreground = 0;
  #sequence = 0;
  #detachParentAbort: (() => void) | undefined;
  #detachFromParent: ((child: Lifetime) => void) | undefined;
  #completion: Promise<void> | undefined;
  #shutdownWork: Promise<void> | undefined;
  #timeoutFailure: RecordedFailure | undefined;
  readonly handle: LifetimeContext;

  constructor(options: LifetimeOptions, ownership?: ChildOwnership) {
    validateLabel(options.label);
    if (typeof options.report !== "function")
      throw new TypeError("Lifetime error reporter must be a function");
    if (
      options.shutdownTimeoutMs !== undefined &&
      (!Number.isFinite(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0)
    ) {
      throw new TypeError("shutdownTimeoutMs must be a positive finite number");
    }
    this.#label = options.label;
    this.#report = options.report;
    this.#changed = options.changed;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.#visibility = ownership?.visibility ?? new Visibility();
    this.#detachFromParent = ownership?.detach;
    if (options.parentSignal) {
      const parent = options.parentSignal;
      const abort = () => this.#controller?.abort(parent.reason);
      parent.addEventListener("abort", abort, { once: true });
      this.#detachParentAbort = () => parent.removeEventListener("abort", abort);
      if (parent.aborted) abort();
    }
    const lifetime = this;
    this.handle = Object.freeze({
      get signal() {
        return lifetime.signal;
      },
      use: <T extends Resource>(resource: T) => this.use(resource),
      defer: (cleanup: Cleanup) => this.defer(cleanup),
      child: (label: string) => this.child(label),
      spawn: <T>(task: BackgroundTask<T>) => this.spawn(task),
      acquire: <T extends Resource>(factory: (signal: AbortSignal) => Awaitable<T>) =>
        this.acquire(factory),
      interrupt: (callback: Cleanup) => this.interrupt(callback),
      [asyncDisposeSymbol]: () => this.dispose(),
    });
    lifetimeAuthorities.set(this.handle, this);
  }

  resolveOwner(context?: LifetimeContext): Lifetime {
    this.#requireActive();
    if (context === undefined) return this;
    const owner = lifetimeAuthorities.get(context);
    if (!owner || !this.#contains(owner))
      throw new TypeError("Lifetime owner must belong to the current scope tree");
    owner.#requireActive();
    return owner;
  }

  #contains(owner: Lifetime): boolean {
    return this === owner || [...this.#children].some((child) => child.#contains(owner));
  }

  get signal() {
    return this.#controller?.signal ?? disposedSignal;
  }
  get phase() {
    return this.#phase;
  }
  get published() {
    return this.#visibility.published;
  }
  get busy(): boolean {
    return this.#foreground > 0 || [...this.#children].some((child) => child.busy);
  }

  snapshot(): LifetimeSnapshot {
    const unresolved: UnresolvedObligation[] = [];
    const add = (id: number, kind: ObligationKind, error: RecordedFailure | undefined) => {
      if (error) unresolved.push(Object.freeze({ id, kind, error: error.snapshot }));
    };
    for (const record of this.#cleanups) add(record.id, record.kind, record.failure);
    for (const record of this.#interrupts) add(record.id, record.kind, record.failure);
    for (const record of this.#publications) add(record.id, "publication", record.failure);
    add(0, "shutdown", this.#timeoutFailure);
    return Object.freeze({
      label: this.#label,
      phase: this.#phase,
      cleanups: this.#cleanups.size,
      tasks: this.#tasks.size,
      acquisitions: this.#acquisitions.size,
      publications: this.#publications.size,
      foreground: this.#foreground,
      unresolved: Object.freeze(unresolved),
      children: Object.freeze([...this.#children].map((child) => child.snapshot())),
    });
  }

  use<T extends Resource>(resource: T): T {
    this.#requireActive();
    const release = captureDisposer(resource);
    this.#requireActive();
    this.#own(release, "cleanup");
    return resource;
  }

  own(resource: Resource): () => void {
    this.#requireActive();
    const release = captureDisposer(resource);
    this.#requireActive();
    const record = this.#own(release, "cleanup");
    return () => record.forget();
  }

  defer(cleanup: Cleanup): AsyncDisposable {
    this.#requireActive();
    if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function");
    const record = this.#own(cleanup, "cleanup");
    return Object.freeze({ [asyncDisposeSymbol]: () => record.dispose() });
  }

  interrupt(callback: Cleanup): Disposable {
    this.#requireActive();
    if (typeof callback !== "function") throw new TypeError("Interrupt must be a function");
    const record = this.#own(callback, "interrupt");
    return Object.freeze({ [disposeSymbol]: () => record.forget() });
  }

  child(label: string): LifetimeContext {
    this.#requireActive();
    const child = new Lifetime(
      {
        label,
        report: (error) => this.#reportError(error),
        changed: () => this.#changed?.(),
        parentSignal: this.signal,
        ...(this.#shutdownTimeoutMs === undefined
          ? {}
          : { shutdownTimeoutMs: this.#shutdownTimeoutMs }),
      },
      {
        visibility: this.#visibility,
        detach: (current) => {
          this.#children.delete(current);
          this.#changed?.();
        },
      },
    );
    this.#children.add(child);
    this.#changed?.();
    return child.handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    this.#requireActive();
    if (typeof task !== "function") throw new TypeError("Background task must be a function");
    let record: TaskRecord<T>;
    record = new TaskRecord(
      this.signal,
      task,
      (error) => this.#reportError(error),
      () => {
        this.#tasks.delete(record as TaskRecord<unknown>);
        this.#changed?.();
      },
    );
    this.#tasks.add(record as TaskRecord<unknown>);
    this.#changed?.();
    return record;
  }

  prepare<T>(task: BackgroundTask<T>): Promise<T> {
    this.#requireActive();
    if (typeof task !== "function") throw new TypeError("Preparation must be a function");
    let record: TaskRecord<T>;
    record = new TaskRecord(this.signal, task, undefined, () => {
      this.#tasks.delete(record as TaskRecord<unknown>);
      this.#changed?.();
    });
    this.#tasks.add(record as TaskRecord<unknown>);
    this.#changed?.();
    return record.result;
  }

  acquire<T extends Resource>(factory: (signal: AbortSignal) => Awaitable<T>): Promise<T> {
    this.#requireActive();
    if (typeof factory !== "function") throw new TypeError("Acquisition must be a function");
    const completion = Promise.resolve()
      .then(() => factory(this.signal))
      .then(async (resource) => {
        const record = this.#own(captureDisposer(resource), "cleanup");
        if (this.#phase !== "active" || this.signal.aborted) {
          await record.dispose();
          throw this.signal.reason ?? disposalReason;
        }
        return resource;
      });
    this.#acquisitions.add(completion);
    this.#changed?.();
    const detach = () => {
      this.#acquisitions.delete(completion);
      this.#changed?.();
    };
    void completion.then(detach, detach);
    return completion;
  }

  stage<T extends Publication>(create: (detach: () => void) => T): T {
    this.#requireActive();
    let record: PublicationRecord | undefined;
    const publication = create(() => {
      if (record) this.#publications.delete(record);
      this.#changed?.();
    });
    record = new PublicationRecord(++this.#sequence, publication);
    this.#publications.add(record);
    this.#changed?.();
    if (this.published) publication.publish();
    return publication;
  }

  borrow<T>(callback: () => Awaitable<T>): Promise<T> {
    this.#requireActive();
    if (typeof callback !== "function") throw new TypeError("Borrow callback must be a function");
    this.#foreground++;
    this.#changed?.();
    let result: Awaitable<T>;
    try {
      result = callback();
    } catch (error) {
      this.#foreground--;
      this.#changed?.();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => {
      this.#foreground--;
      this.#changed?.();
    });
  }

  seal() {
    if (this.busy) throw new DougongError("BUSY", "Lifetime has in-flight foreground work");
    if (this.#phase !== "active") return;
    this.#sealTree();
  }

  block() {
    this.#sealTree();
  }

  #sealTree() {
    if (this.#phase === "active") this.#phase = "sealed";
    for (const child of this.#children) child.#sealTree();
  }

  publish() {
    this.#requireActive();
    if (this.#detachFromParent)
      throw new TypeError("Only the root Lifetime may publish declarations");
    if (this.#visibility.published) return;
    this.#visibility.published = true;
    this.#publishTree();
  }

  #publishTree() {
    for (const record of this.#publications) record.publication.publish();
    for (const child of this.#children) child.#publishTree();
  }

  detachStartupSignal() {
    this.#detachParentAbort?.();
    this.#detachParentAbort = undefined;
  }

  dispose(): Promise<void> {
    if (this.#completion) return this.#completion;
    if (this.#phase === "disposed") return Promise.resolve();
    try {
      this.seal();
    } catch (error) {
      return Promise.reject(error);
    }
    const completion = Promise.withResolvers<void>();
    this.#completion = completion.promise;
    const shutdown = this.#shutdown();
    this.#shutdownWork = shutdown;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (this.#shutdownTimeoutMs !== undefined) {
      timeout = setTimeout(() => {
        const failure = new DougongError(
          "SHUTDOWN_TIMEOUT",
          "Lifetime shutdown did not complete before its deadline",
        );
        this.#timeoutFailure = new RecordedFailure(failure);
        this.#phase = "quarantined";
        this.#changed?.();
        completion.reject(failure);
      }, this.#shutdownTimeoutMs);
    }
    void shutdown.then(
      () => {
        if (timeout !== undefined) clearTimeout(timeout);
        this.#timeoutFailure = undefined;
        completion.resolve();
      },
      (error) => {
        if (timeout !== undefined) clearTimeout(timeout);
        completion.reject(error);
      },
    );
    return completion.promise;
  }

  async #shutdown() {
    this.#phase = "disposing";
    const errors: unknown[] = [];
    try {
      batchSnapshotNotifications(() => {
        this.#changed?.();
        this.#withdrawTree(errors);
      });
    } catch (error) {
      errors.push(error);
    }
    this.#controller?.abort(disposalReason);
    this.detachStartupSignal();
    const children = Promise.allSettled(
      [...this.#children].reverse().map((child) => {
        const completion = child.dispose();
        void completion.catch(() => undefined);
        // A child's deadline ends its caller's wait, not its use of parent-owned resources.
        return child.#shutdownWork ?? completion;
      }),
    );
    await this.#releaseRecords(this.#interrupts, errors);
    const tasks = [...this.#tasks].map((task) => task[asyncDisposeSymbol]());
    await Promise.all(tasks);
    await Promise.allSettled([...this.#acquisitions]);
    const childResults = await children;
    for (const result of childResults) if (result.status === "rejected") errors.push(result.reason);
    if (childResults.every((result) => result.status === "fulfilled")) {
      await this.#releaseRecords(this.#cleanups, errors);
    }
    if (errors.length) {
      this.#phase = "quarantined";
      this.#changed?.();
      throw new AggregateError(errors, "Lifetime has unresolved cleanup obligations");
    }
    this.#phase = "disposed";
    this.#controller = undefined;
    this.#changed?.();
    this.#changed = undefined;
    const detach = this.#detachFromParent;
    this.#detachFromParent = undefined;
    detach?.(this);
    this.#report = undefined;
  }

  #withdrawTree(errors: unknown[]) {
    for (const record of [...this.#publications].reverse()) {
      try {
        record.withdraw();
        this.#publications.delete(record);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const child of this.#children) child.#withdrawTree([]);
  }

  async #releaseRecords(records: Set<CleanupRecord>, errors: unknown[]) {
    for (const record of [...records].reverse()) {
      try {
        await record.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  #own(cleanup: Cleanup, kind: "cleanup" | "interrupt") {
    const records = kind === "cleanup" ? this.#cleanups : this.#interrupts;
    let record: CleanupRecord;
    record = new CleanupRecord(
      ++this.#sequence,
      kind,
      cleanup,
      () => {
        records.delete(record);
        this.#changed?.();
      },
      () => this.#changed?.(),
    );
    records.add(record);
    this.#changed?.();
    return record;
  }

  #reportError(error: unknown) {
    if (this.#report)
      assertSynchronous(this.#report(error), "Lifetime error reporters must be synchronous");
  }

  #requireActive() {
    if (this.#phase !== "active" || this.signal.aborted) {
      throw new DougongError("LIFETIME_DISPOSED", "Lifetime is closed to new work");
    }
  }
}

function validateLabel(label: string) {
  if (typeof label !== "string" || !label.trim() || label !== label.trim()) {
    throw new TypeError("Lifetime label must be a non-empty trimmed string");
  }
}
