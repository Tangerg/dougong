import {
  DougongError,
  isCancellationReason,
  RecordedFailure,
  lifetimeBusyCode,
  lifetimeDisposedCode,
  shutdownTimeoutCode,
} from "../contracts/errors.js";
import { abortReason, isAborted, onAbort } from "../internal/abort.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertSynchronous } from "../internal/synchronous-result.js";
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

export interface LifetimeContext {
  readonly signal: AbortSignal;
  readonly use: <T extends Resource>(resource: T) => T;
  readonly defer: (cleanup: Cleanup) => AsyncDisposable;
  readonly child: (label: string) => ChildLifetime;
  readonly spawn: <T>(task: BackgroundTask<T>) => Task<T>;
  readonly acquire: <T extends Resource>(
    factory: (signal: AbortSignal) => Awaitable<T>,
  ) => Promise<{ readonly resource: T }>;
  readonly interrupt: (callback: Cleanup) => Disposable;
}

export interface ChildLifetime extends LifetimeContext, AsyncDisposable {
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LifetimeOwnership {
  readonly lifetime?: LifetimeContext;
}

const ownershipFields = recordFields<LifetimeOwnership>()("lifetime");
const lifetimeAuthorities = new WeakMap<object, Lifetime>();
const claimedResources = new WeakSet<Resource>();

export interface LifetimeOptions {
  readonly label: string;
  readonly report: (error: unknown) => void;
  readonly releaseFailed?: (failure: ReleaseFailure) => void;
  readonly changed?: () => void;
  readonly parentSignal?: AbortSignal;
  readonly shutdownTimeoutMilliseconds?: number;
}

export interface ReleaseFailure {
  readonly owner: Lifetime;
  readonly kind: ObligationKind;
  readonly error: unknown;
}

interface ChildOwnership {
  readonly visibility: Visibility;
  readonly detach: (child: Lifetime) => void;
}

class Visibility {
  published = false;
}

function createDisposalReason() {
  const reason = new DOMException("Resource disposed", "AbortError");
  // Independent cancellation needs its own identity, without retaining completed stack frames.
  Reflect.set(reason, "stack", undefined);
  return Object.freeze(reason);
}

class CleanupRecord {
  readonly id: number;
  readonly kind: "cleanup" | "interrupt";
  #cleanup: Cleanup | undefined;
  #detach: (() => void) | undefined;
  #completion: Promise<void> | undefined;
  #failure: RecordedFailure | undefined;
  #releaseFailed: ((error: unknown) => void) | undefined;
  #changed: (() => void) | undefined;

  constructor(
    id: number,
    kind: "cleanup" | "interrupt",
    cleanup: Cleanup,
    detach: () => void,
    releaseFailed: (error: unknown) => void,
    changed: () => void,
  ) {
    this.#releaseFailed = releaseFailed;
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
    this.#completion = Object.freeze(completion.promise);
    void Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          this.#cleanup = undefined;
          const detach = this.#detach;
          this.#detach = undefined;
          this.#releaseFailed = undefined;
          this.#changed = undefined;
          detach?.();
          completion.resolve();
        },
        (error) => {
          // A failed release still belongs to this record; retrying an arbitrary callback is unsafe.
          this.#releaseFailed?.(error);
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
    this.#releaseFailed = undefined;
    this.#changed = undefined;
    const detach = this.#detach;
    this.#detach = undefined;
    detach?.();
  }
}

class PublicationRecord {
  readonly id: number;
  readonly publication: Publication;
  failure: { readonly reason: unknown; recorded: RecordedFailure | undefined } | undefined;
  #releaseFailed: ((error: unknown) => void) | undefined;

  constructor(id: number, publication: Publication, releaseFailed: (error: unknown) => void) {
    this.id = id;
    this.publication = publication;
    this.#releaseFailed = releaseFailed;
  }

  withdraw(): boolean {
    if (this.failure) return false;
    try {
      assertSynchronous(
        this.publication[disposeSymbol](),
        "Publication withdrawal must be synchronous",
      );
    } catch (error) {
      this.failure = { reason: error, recorded: undefined };
      this.#releaseFailed?.(error);
      this.failure.recorded = new RecordedFailure(error);
      return false;
    }
    this.#releaseFailed = undefined;
    return true;
  }
}

class TaskRecord<T> {
  readonly handle: Task<T>;
  #controller: AbortController | undefined;
  #detach: (() => void) | undefined;
  readonly settled: Promise<void>;

  constructor(
    task: BackgroundTask<T>,
    report: ((error: unknown) => void) | undefined,
    detach: () => void,
  ) {
    const controller = new AbortController();
    this.#controller = controller;
    this.#detach = detach;
    let reporter = report;
    const failed = (error: unknown) => {
      if (!reporter) return;
      const notify = reporter;
      reporter = undefined;
      try {
        if (!isCancellationReason(controller.signal, error)) notify(error);
      } catch (reporterError) {
        queueMicrotask(() => {
          throw reporterError;
        });
      }
    };
    const result = Promise.resolve().then(() => task(controller.signal));
    this.settled = Object.freeze(
      result.then(
        () => this.#settle(),
        (error: unknown) => {
          failed(error);
          this.#settle();
        },
      ),
    );
    this.handle = Object.freeze({
      result,
      [asyncDisposeSymbol]: this.#dispose.bind(this),
    });
  }

  #settle() {
    this.#controller = undefined;
    const detach = this.#detach;
    this.#detach = undefined;
    detach?.();
  }

  #dispose() {
    this.cancel(createDisposalReason());
    return this.settled;
  }

  cancel(reason: unknown) {
    const controller = this.#controller;
    this.#controller = undefined;
    controller?.abort(reason);
  }
}

export class Lifetime {
  readonly #label: string;
  #cancellation: { readonly signal: AbortSignal; abort?(reason: unknown): void } =
    new AbortController();
  readonly #visibility: Visibility;
  readonly #children = new Set<Lifetime>();
  readonly #cleanups = new Set<CleanupRecord>();
  readonly #interrupts = new Set<CleanupRecord>();
  readonly #publications = new Set<PublicationRecord>();
  readonly #tasks = new Set<TaskRecord<unknown>>();
  readonly #acquisitions = new Set<Promise<void>>();
  readonly #shutdownTimeoutMilliseconds: number | undefined;
  #report: ((error: unknown) => void) | undefined;
  #releaseFailed: ((failure: ReleaseFailure) => void) | undefined;
  #changed: (() => void) | undefined;
  #phase: LifetimePhase = "active";
  #foreground = 0;
  #sequence = 0;
  #detachParentAbort: (() => void) | undefined;
  #detachFromParent: ((child: Lifetime) => void) | undefined;
  #completion: Promise<void> | undefined;
  #shutdownWork: Promise<void> | undefined;
  #timeoutFailure: RecordedFailure | undefined;
  #handle: LifetimeContext | undefined;

  constructor(options: LifetimeOptions, ownership?: ChildOwnership) {
    validateLabel(options.label);
    if (typeof options.report !== "function")
      throw new TypeError("Lifetime error reporter must be a function");
    this.#label = options.label;
    this.#report = options.report;
    this.#releaseFailed = options.releaseFailed;
    this.#changed = options.changed;
    this.#shutdownTimeoutMilliseconds = shutdownTimeout(options.shutdownTimeoutMilliseconds);
    this.#visibility = ownership?.visibility ?? new Visibility();
    this.#detachFromParent = ownership?.detach;
    if (options.parentSignal) {
      this.#detachParentAbort = onAbort(options.parentSignal, (reason) => {
        this.block();
        this.#cancelTree(reason);
      });
    }
  }

  get handle(): LifetimeContext {
    return (this.#handle ??= this.#context({}));
  }

  #context<Rights extends object>(rights: Rights): LifetimeContext & Rights {
    const lifetime = this;
    const handle = Object.freeze({
      ...rights,
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
    });
    lifetimeAuthorities.set(handle, this);
    return handle;
  }

  resolveOwner(options?: LifetimeOwnership): Lifetime {
    const context =
      options === undefined
        ? undefined
        : normalizePlainRecord(options, "Lifetime ownership", { fields: ownershipFields }).lifetime;
    this.#requireActive();
    if (context === undefined) return this;
    const owner = lifetimeAuthorities.get(context);
    if (!owner || !this.#treeContains(owner))
      throw new TypeError("Lifetime owner must belong to the current scope tree");
    owner.#requireActive();
    return owner;
  }

  *#tree(): IterableIterator<Lifetime> {
    const stack: Lifetime[] = [this];
    while (stack.length) {
      const scope = stack.pop()!;
      yield scope;
      for (const child of [...scope.#children].reverse()) stack.push(child);
    }
  }

  #treeContains(owner: Lifetime): boolean {
    for (const scope of this.#tree()) if (scope === owner) return true;
    return false;
  }

  get signal() {
    return this.#cancellation.signal;
  }
  get phase() {
    return this.#phase;
  }
  get acceptsWork() {
    return this.#phase === "active" && !isAborted(this.signal);
  }
  get published() {
    return this.#visibility.published;
  }
  get busy(): boolean {
    for (const scope of this.#tree()) if (scope.#foreground > 0) return true;
    return false;
  }

  snapshot(): LifetimeSnapshot {
    const snapshots = new Map<Lifetime, LifetimeSnapshot>();
    for (const scope of [...this.#tree()].reverse())
      snapshots.set(
        scope,
        scope.#snapshot([...scope.#children].map((child) => snapshots.get(child)!)),
      );
    return snapshots.get(this)!;
  }

  #snapshot(children: LifetimeSnapshot[]): LifetimeSnapshot {
    const unresolved: UnresolvedObligation[] = [];
    const add = (id: number, kind: ObligationKind, error: RecordedFailure | undefined) => {
      if (error) unresolved.push(Object.freeze({ id, kind, error: error.snapshot }));
    };
    for (const record of this.#cleanups) add(record.id, record.kind, record.failure);
    for (const record of this.#interrupts) add(record.id, record.kind, record.failure);
    for (const record of this.#publications)
      add(record.id, "publication", record.failure?.recorded);
    add(0, "shutdown", this.#timeoutFailure);
    return Object.freeze({
      label: this.#label,
      phase: this.#phase,
      cleanups: this.#cleanups.size,
      interrupts: this.#interrupts.size,
      tasks: this.#tasks.size,
      acquisitions: this.#acquisitions.size,
      publications: this.#publications.size,
      foreground: this.#foreground,
      unresolved: Object.freeze(unresolved),
      children: Object.freeze(children),
    });
  }

  use<T extends Resource>(resource: T): T {
    this.#adopt(resource);
    return resource;
  }

  own(resource: Resource): () => void {
    const record = this.#adopt(resource);
    return () => record.forget();
  }

  #adopt(resource: Resource, reservedAcquisition = false) {
    if (!reservedAcquisition) this.#requireActive();
    if (lifetimeAuthorities.has(resource))
      throw new TypeError("Lifetime handles cannot be adopted as resources");
    if (claimedResources.has(resource))
      throw new TypeError("Resource already has a Lifetime owner");
    // A protocol getter may reenter adoption before the release record exists.
    claimedResources.add(resource);
    let release: Cleanup;
    try {
      release = captureDisposer(resource);
      if (!reservedAcquisition) this.#requireActive();
    } catch (error) {
      claimedResources.delete(resource);
      throw error;
    }
    return this.#own(release, "cleanup", resource);
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

  child(label: string): ChildLifetime {
    this.#requireActive();
    const child = new Lifetime(
      {
        label,
        report: this.#report!,
        ...(this.#releaseFailed && { releaseFailed: this.#releaseFailed }),
        ...(this.#changed && { changed: this.#changed }),
        ...(this.#shutdownTimeoutMilliseconds === undefined
          ? {}
          : { shutdownTimeoutMilliseconds: this.#shutdownTimeoutMilliseconds }),
      },
      {
        visibility: this.#visibility,
        detach: (current) => this.#children.delete(current),
      },
    );
    this.#children.add(child);
    this.#changed?.();
    const handle = child.#context({ [asyncDisposeSymbol]: child.dispose.bind(child) });
    child.#handle = handle;
    return handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    return this.#startTask(task, (error) => this.#reportError(error));
  }

  prepare<T>(task: BackgroundTask<T>): Promise<T> {
    return this.#startTask(task).result;
  }

  #startTask<T>(task: BackgroundTask<T>, report?: (error: unknown) => void): Task<T> {
    this.#requireActive();
    if (typeof task !== "function") throw new TypeError("Task must be a function");
    const record: TaskRecord<T> = new TaskRecord(task, report, () => {
      this.#tasks.delete(record);
      this.#changed?.();
    });
    this.#tasks.add(record);
    this.#changed?.();
    return record.handle;
  }

  acquire<T extends Resource>(
    factory: (signal: AbortSignal) => Awaitable<T>,
  ): Promise<{ readonly resource: T }> {
    this.#requireActive();
    if (typeof factory !== "function") throw new TypeError("Acquisition must be a function");
    const completion = Promise.resolve()
      .then(() => factory(this.signal))
      .then(async (resource) => {
        const record = this.#adopt(resource, true);
        if (!this.acceptsWork) {
          const reason = isAborted(this.signal) ? abortReason(this.signal) : createDisposalReason();
          await record.dispose();
          throw reason;
        }
        // Deliver the adopted identity as data; resolving another Promise with it could call its then property again.
        return Object.freeze({ resource });
      });
    const detach = () => {
      this.#acquisitions.delete(join);
      this.#changed?.();
    };
    // Shutdown joins its own settlement reaction, never an application-overridable result.
    const join = completion.then(detach, detach);
    this.#acquisitions.add(join);
    this.#changed?.();
    return completion;
  }

  stage<T extends Publication>(create: (detach: () => void) => T): T {
    this.#requireActive();
    let record: PublicationRecord | undefined;
    const publication = create(() => {
      if (record && !record.failure) this.#publications.delete(record);
      this.#changed?.();
    });
    record = new PublicationRecord(++this.#sequence, publication, (error) =>
      this.#notifyReleaseFailure(error, "publication"),
    );
    this.#publications.add(record);
    batchSnapshotNotifications(() => {
      this.#changed?.();
      if (this.published) publication.publish();
    });
    return publication;
  }

  borrow<T>(callback: () => Awaitable<T>): Promise<T> {
    this.#requireActive();
    if (typeof callback !== "function") throw new TypeError("Borrow callback must be a function");
    this.#foreground++;
    this.#changed?.();
    const release = () => {
      this.#foreground--;
      this.#changed?.();
    };
    try {
      const value = callback();
      const result = new Promise<T>((resolve) => resolve(value));
      // A finally() chain would adopt its value a second time after releasing the borrow.
      void result.then(release, release);
      return result;
    } catch (error) {
      release();
      return Promise.reject(error);
    }
  }

  seal() {
    if (this.busy)
      throw new DougongError(lifetimeBusyCode, "Lifetime has in-flight foreground work");
    this.block();
  }

  block() {
    for (const scope of this.#tree()) if (scope.#phase === "active") scope.#phase = "sealed";
  }

  #cancelTree(reason: unknown) {
    // The owner broadcasts over its records. A listener on a public signal may stop DOM event propagation.
    for (const scope of this.#tree()) {
      scope.#cancellation.abort?.(reason);
      for (const task of scope.#tasks) task.cancel(reason);
    }
  }

  publish() {
    this.#requireActive();
    if (this.#detachFromParent)
      throw new TypeError("Only the root Lifetime may publish declarations");
    if (this.#visibility.published) return;
    this.#visibility.published = true;
    for (const scope of this.#tree())
      for (const record of scope.#publications) record.publication.publish();
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
    const entering = [...this.#tree()].filter((scope) => !scope.#completion);
    const errors: unknown[] = [];
    // Reserve every real join before withdrawal or cancellation can reenter a child or its parent.
    for (let index = entering.length - 1; index >= 0; index--) {
      const scope = entering[index]!;
      scope.#beginShutdown(scope === this ? errors : []);
    }
    try {
      batchSnapshotNotifications(() => {
        for (const scope of entering) scope.#withdraw();
        this.#changed?.();
      });
    } catch (error) {
      errors.push(error);
    }
    this.#cancelTree(createDisposalReason());
    return this.#completion!;
  }

  #beginShutdown(errors: unknown[]) {
    this.#phase = "disposing";
    this.detachStartupSignal();
    const work = Promise.resolve().then(() => this.#finishShutdown(errors));
    this.#shutdownWork = work;
    if (this.#shutdownTimeoutMilliseconds === undefined) {
      this.#completion = Object.freeze(work);
      return;
    }
    const completion = Promise.withResolvers<void>();
    this.#completion = Object.freeze(completion.promise);
    // A nested deadline can expire without a direct caller waiting on the child receipt.
    void completion.promise.catch(() => undefined);
    const timeout = setTimeout(() => {
      const failure = new DougongError(
        shutdownTimeoutCode,
        "Lifetime shutdown did not complete before its deadline",
      );
      this.#phase = "quarantined";
      this.#notifyReleaseFailure(failure, "shutdown");
      this.#timeoutFailure = new RecordedFailure(failure);
      this.#changed?.();
      completion.reject(failure);
    }, this.#shutdownTimeoutMilliseconds);
    void work.then(
      () => {
        clearTimeout(timeout);
        completion.resolve();
      },
      (error) => {
        clearTimeout(timeout);
        completion.reject(error);
      },
    );
  }

  async #finishShutdown(errors: unknown[]) {
    for (const record of this.#publications) {
      if (record.failure) errors.push(record.failure.reason);
    }
    // A child's deadline ends its caller's wait, not its use of parent-owned resources.
    const children = Promise.allSettled([...this.#children].map((child) => child.#shutdownWork!));
    // An interruption may await work unblocked by another one in the same scope.
    const interruptions = [...this.#interrupts].reverse().map((record) => record.dispose());
    for (const result of await Promise.allSettled(interruptions)) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    const tasks = [...this.#tasks].map((task) => task.settled);
    await Promise.all(tasks);
    await Promise.allSettled([...this.#acquisitions]);
    const childResults = await children;
    for (const result of childResults) if (result.status === "rejected") errors.push(result.reason);
    if (childResults.every((result) => result.status === "fulfilled")) {
      for (const record of [...this.#cleanups].reverse()) {
        try {
          await record.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.#timeoutFailure = undefined;
    if (errors.length) {
      this.#phase = "quarantined";
      this.#changed?.();
      throw new AggregateError(errors, "Lifetime has unresolved cleanup obligations");
    }
    this.#phase = "disposed";
    // Detach the original signal's listeners/reason without pinning every retired scope's
    // future listeners to a globally shared EventTarget.
    this.#cancellation = { signal: AbortSignal.abort(createDisposalReason()) };
    const detach = this.#detachFromParent;
    this.#detachFromParent = undefined;
    detach?.(this);
    this.#report = undefined;
    this.#releaseFailed = undefined;
    this.#changed?.();
    this.#changed = undefined;
  }

  #withdraw() {
    for (const record of [...this.#publications].reverse()) {
      if (record.withdraw()) this.#publications.delete(record);
      // A publication may detach before its withdrawal fails; the unfinished obligation still belongs here.
      else this.#publications.add(record);
    }
  }

  #own(cleanup: Cleanup, kind: "cleanup" | "interrupt", resource?: Resource) {
    const records = kind === "cleanup" ? this.#cleanups : this.#interrupts;
    let record: CleanupRecord;
    record = new CleanupRecord(
      ++this.#sequence,
      kind,
      cleanup,
      () => {
        records.delete(record);
        if (resource !== undefined) claimedResources.delete(resource);
        this.#changed?.();
      },
      (error) => this.#notifyReleaseFailure(error, kind),
      () => this.#changed?.(),
    );
    records.add(record);
    this.#changed?.();
    return record;
  }

  #reportError(error: unknown) {
    const report = this.#report;
    if (report) assertSynchronous(report(error), "Lifetime error reporters must be synchronous");
  }

  #notifyReleaseFailure(error: unknown, kind: ObligationKind) {
    this.#releaseFailed?.(Object.freeze({ owner: this, kind, error }));
  }

  #requireActive() {
    if (!this.acceptsWork) {
      throw new DougongError(lifetimeDisposedCode, "Lifetime is closed to new work");
    }
  }
}

// Native timers use a signed 32-bit millisecond delay; overflow can expire almost immediately.
const maximumTimerDelay = 2 ** 31 - 1;
export function shutdownTimeout(value: unknown): number | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximumTimerDelay
  )
    throw new TypeError(
      `shutdownTimeoutMilliseconds must be a positive finite number no greater than ${maximumTimerDelay}`,
    );
  return value;
}

function validateLabel(label: string) {
  if (typeof label !== "string" || !label.trim() || label !== label.trim()) {
    throw new TypeError("Lifetime label must be a non-empty trimmed string");
  }
}
