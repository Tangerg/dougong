import {
  DougongError,
  lifetimeBusyCode,
  lifetimeDisposedCode,
  shutdownTimeoutCode,
} from "../contracts/errors.js";
import { RecordedFailure } from "../contracts/recorded-failure.js";
import { abortReason, isAborted, onAbort } from "../internal/abort.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertTrimmedText } from "../internal/text.js";
import { captureTimerDelay } from "../internal/timer.js";
import { assertSynchronous, resolveValue, type ResolvedValue } from "../internal/async-result.js";
import { batchSnapshotNotifications } from "../observation/snapshot-view.js";
import type {
  LifetimePhase,
  LifetimeSnapshot,
  ObligationKind,
  UnresolvedObligation,
} from "./lifetime-diagnostics.js";
import {
  CleanupRecord,
  PublicationRecord,
  TaskRecord,
  createDisposalReason,
  type BackgroundTask,
  type Cleanup,
  type CleanupKind,
  type Task,
} from "./obligations.js";
import {
  asyncDisposeSymbol,
  captureDisposer,
  disposeSymbol,
  type AsyncDisposable,
  type Awaitable,
  type Disposable,
  type Publication,
  type Resource,
  type ResourceAuthority,
} from "../contracts/resource.js";

export type {
  LifetimePhase,
  LifetimeSnapshot,
  UnresolvedObligation,
} from "./lifetime-diagnostics.js";
export type { BackgroundTask, Cleanup, Task } from "./obligations.js";

type AcquisitionResult<T> = T & NoInfer<Awaited<T> extends Resource ? unknown : never>;

export interface LifetimeContext {
  readonly signal: AbortSignal;
  readonly use: <T extends Resource>(resource: T) => T;
  readonly defer: (cleanup: Cleanup) => AsyncDisposable;
  readonly child: (label: string) => ChildLifetime;
  readonly spawn: <T>(task: BackgroundTask<T>) => Task<Awaited<T>>;
  readonly acquire: <T>(
    factory: (signal: AbortSignal) => AcquisitionResult<T>,
  ) => Promise<{ readonly resource: Awaited<T> }>;
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

export interface LifetimeOptions {
  readonly resourceAuthority: ResourceAuthority;
  readonly label: string;
  readonly report: (error: unknown) => void;
  readonly releaseFailed?: (failure: ReleaseFailure) => void;
  readonly changed?: () => void;
  readonly startupSignal?: AbortSignal;
  readonly shutdownTimeoutMilliseconds?: number;
}

export interface ReleaseFailure {
  readonly owner: Lifetime;
  readonly kind: ObligationKind;
  readonly error: unknown;
}

// A whole tree shares one observer; a disposed scope drops it so retired handles retain no callbacks.
interface LifetimeObserver {
  readonly report: (error: unknown) => void;
  readonly releaseFailed: ((failure: ReleaseFailure) => void) | undefined;
  readonly changed: (() => void) | undefined;
}

interface ChildOwnership {
  readonly visibility: Visibility;
  readonly detach: (child: Lifetime) => void;
}

// Only the root publishes; its children share the flag so later registrations publish at once.
class Visibility {
  published = false;
}

export class Lifetime {
  readonly resourceAuthority: ResourceAuthority;
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
  readonly #foreground = new Set<Promise<void>>();
  readonly #settlement = Promise.withResolvers<void>();
  readonly #shutdownTimeoutMilliseconds: number | undefined;
  #observer: LifetimeObserver | undefined;
  #phase: LifetimePhase = "active";
  #sequence = 0;
  #detachStartupAbort: (() => void) | undefined;
  #detachFromParent: ((child: Lifetime) => void) | undefined;
  #completion: Promise<void> | undefined;
  #timeoutFailure: RecordedFailure | undefined;
  #handle: LifetimeContext | undefined;

  constructor(options: LifetimeOptions, ownership?: ChildOwnership) {
    assertTrimmedText(options.label, "Lifetime label");
    if (typeof options.report !== "function")
      throw new TypeError("Lifetime error reporter must be a function");
    this.resourceAuthority = options.resourceAuthority;
    this.#label = options.label;
    this.#observer = {
      report: options.report,
      releaseFailed: options.releaseFailed,
      changed: options.changed,
    };
    this.#shutdownTimeoutMilliseconds = captureTimerDelay(
      options.shutdownTimeoutMilliseconds,
      "shutdownTimeoutMilliseconds",
    );
    this.#visibility = ownership?.visibility ?? new Visibility();
    this.#detachFromParent = ownership?.detach;
    Object.freeze(this.#settlement.promise);
    // A deadline may end the caller's wait before the real shutdown rejects.
    void this.#settlement.promise.catch(() => undefined);
    if (options.startupSignal) {
      this.#detachStartupAbort = onAbort(options.startupSignal, (reason) => {
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
      acquire: <T>(factory: (signal: AbortSignal) => AcquisitionResult<T>) => this.acquire(factory),
      interrupt: (callback: Cleanup) => this.interrupt(callback),
    });
    this.resourceAuthority.markControlHandle(handle);
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
  get settled() {
    return this.#settlement.promise;
  }
  get acceptsWork() {
    return this.#phase === "active" && !isAborted(this.signal);
  }
  get published() {
    return this.#visibility.published;
  }
  get busy(): boolean {
    for (const scope of this.#tree()) if (scope.#foreground.size > 0) return true;
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
    const add = (
      id: number,
      kind: Exclude<ObligationKind, "shutdown">,
      error: RecordedFailure | undefined,
    ) => {
      if (error) unresolved.push(Object.freeze({ id, kind, error: error.snapshot }));
    };
    for (const record of this.#cleanups) add(record.id, record.kind, record.failure);
    for (const record of this.#interrupts) add(record.id, record.kind, record.failure);
    for (const record of this.#publications)
      add(record.id, "publication", record.failure?.recorded);
    if (this.#timeoutFailure) {
      unresolved.push(Object.freeze({ kind: "shutdown", error: this.#timeoutFailure.snapshot }));
    }
    return Object.freeze({
      label: this.#label,
      phase: this.#phase,
      cleanups: this.#cleanups.size,
      interrupts: this.#interrupts.size,
      tasks: this.#tasks.size,
      acquisitions: this.#acquisitions.size,
      publications: this.#publications.size,
      foreground: this.#foreground.size,
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
    // A protocol getter may reenter adoption before the release record exists.
    const releaseClaim = this.resourceAuthority.claim(resource);
    let release: Cleanup;
    try {
      release = captureDisposer(resource);
      if (!reservedAcquisition) this.#requireActive();
    } catch (error) {
      // Failed capture still owns its reservation until rollback succeeds.
      this.#own(
        () => undefined,
        "cleanup",
        () => {
          try {
            releaseClaim();
          } catch (releaseError) {
            throw new AggregateError(
              [error, releaseError],
              "Resource adoption and reservation release failed",
            );
          }
        },
      ).forget();
      throw error;
    }
    return this.#own(release, "cleanup", releaseClaim);
  }

  defer(cleanup: Cleanup): AsyncDisposable {
    this.#requireActive();
    if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function");
    const record = this.#own(cleanup, "cleanup");
    const handle = Object.freeze({ [asyncDisposeSymbol]: () => record.dispose() });
    this.resourceAuthority.markControlHandle(handle);
    return handle;
  }

  interrupt(callback: Cleanup): Disposable {
    this.#requireActive();
    if (typeof callback !== "function") throw new TypeError("Interrupt must be a function");
    const record = this.#own(callback, "interrupt");
    const handle = Object.freeze({ [disposeSymbol]: () => record.forget() });
    this.resourceAuthority.markControlHandle(handle);
    return handle;
  }

  child(label: string): ChildLifetime {
    const { report, releaseFailed, changed } = this.#requireActive();
    const child = new Lifetime(
      {
        resourceAuthority: this.resourceAuthority,
        label,
        report,
        ...(releaseFailed && { releaseFailed }),
        ...(changed && { changed }),
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
    this.#changed();
    const handle = child.#context({ [asyncDisposeSymbol]: () => child.dispose() });
    child.#handle = handle;
    return handle;
  }

  spawn<T>(task: BackgroundTask<T>): Task<Awaited<T>> {
    return this.#startTask(task, (error) => this.#reportError(error));
  }

  // The caller receives the failure, so it is not also sent to the error reporter.
  run<T>(task: BackgroundTask<T>): Promise<ResolvedValue<Awaited<T>>> {
    return this.#startTask(task).result;
  }

  #startTask<T>(task: BackgroundTask<T>, report?: (error: unknown) => void): Task<Awaited<T>> {
    this.#requireActive();
    if (typeof task !== "function") throw new TypeError("Task must be a function");
    const record: TaskRecord<T> = new TaskRecord(task, report, () => {
      this.#tasks.delete(record);
      this.#changed();
    });
    this.#tasks.add(record);
    try {
      this.resourceAuthority.markControlHandle(record.handle);
      this.#changed();
      record.start();
    } catch (error) {
      record.failStart(error);
      throw error;
    }
    return record.handle;
  }

  acquire<T>(
    factory: (signal: AbortSignal) => AcquisitionResult<T>,
  ): Promise<{ readonly resource: Awaited<T> }> {
    this.#requireActive();
    if (typeof factory !== "function") throw new TypeError("Acquisition must be a function");
    const completion = Promise.resolve()
      .then(() => resolveValue(factory(this.signal)))
      .then(async ({ value: resource }) => {
        const record = this.#adopt(resource as Resource, true);
        // Sealing closes ingress while consumers can still depend on already admitted acquisitions.
        if (isAborted(this.signal)) {
          const reason = abortReason(this.signal);
          await record.dispose();
          throw reason;
        }
        // Deliver the adopted identity as data; resolving another Promise with it could call its then property again.
        return Object.freeze({ resource });
      });
    const detach = () => {
      this.#acquisitions.delete(join);
      this.#changed();
    };
    // Shutdown joins its own settlement reaction, never an application-overridable result.
    const join = completion.then(detach, detach);
    this.#acquisitions.add(join);
    this.#changed();
    return completion;
  }

  stage<T extends Publication>(create: (detach: () => void) => T): T {
    const { report } = this.#requireActive();
    let record: PublicationRecord | undefined;
    const publication = create(() => {
      if (record && !record.failure) this.#publications.delete(record);
      this.#changed();
    });
    record = new PublicationRecord(++this.#sequence, publication, (error) =>
      this.#notifyReleaseFailure(error, "publication"),
    );
    this.#publications.add(record);
    batchSnapshotNotifications(() => {
      this.#changed();
      if (this.published) publication.publish();
    }, report);
    return publication;
  }

  borrow<T>(callback: () => Awaitable<T>): Promise<ResolvedValue<Awaited<T>>> {
    this.#requireActive();
    if (typeof callback !== "function") throw new TypeError("Borrow callback must be a function");
    const obligation = Promise.withResolvers<void>();
    this.#foreground.add(obligation.promise);
    const release = () => {
      this.#foreground.delete(obligation.promise);
      obligation.resolve();
      this.#changed();
    };
    try {
      this.#changed();
      const result = resolveValue(callback());
      // The receipt carries data; this reaction alone releases the foreground obligation.
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
    this.#detachStartupAbort?.();
    this.#detachStartupAbort = undefined;
  }

  // Disposal requires idleness: in-flight foreground work rejects it with LIFETIME_BUSY.
  dispose(): Promise<void> {
    if (this.#completion) return this.#completion;
    if (this.#phase === "disposed") return Promise.resolve();
    try {
      this.seal();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#shutdown();
  }

  // Stopping closes ingress even while foreground work runs; shutdown then cancels and joins it.
  stop(): Promise<void> {
    if (this.#completion) return this.#completion;
    if (this.#phase === "disposed") return Promise.resolve();
    this.block();
    return this.#shutdown();
  }

  #shutdown(): Promise<void> {
    const { report } = this.#observer!;
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
        this.#changed();
      }, report);
    } catch (error) {
      errors.push(error);
    }
    batchSnapshotNotifications(() => this.#cancelTree(createDisposalReason()), report);
    return this.#completion!;
  }

  #beginShutdown(errors: unknown[]) {
    this.#phase = "disposing";
    this.detachStartupSignal();
    void Promise.resolve()
      .then(() => this.#finishShutdown(errors))
      .then(this.#settlement.resolve, this.#settlement.reject);
    if (this.#shutdownTimeoutMilliseconds === undefined) {
      this.#completion = this.settled;
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
      this.#changed();
      completion.reject(failure);
    }, this.#shutdownTimeoutMilliseconds);
    void this.settled.then(
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
    const children = Promise.allSettled([...this.#children].map((child) => child.settled));
    // An interruption may await work unblocked by another one in the same scope.
    const interruptions = [...this.#interrupts].reverse().map((record) => record.dispose());
    for (const result of await Promise.allSettled(interruptions)) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    await Promise.all([...this.#tasks].map((task) => task.settled));
    await Promise.allSettled([...this.#acquisitions]);
    await Promise.all(this.#foreground);
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
      this.#changed();
      throw new AggregateError(errors, "Lifetime has unresolved cleanup obligations");
    }
    this.#phase = "disposed";
    // Detach the original signal's listeners/reason without pinning every retired scope's
    // future listeners to a globally shared EventTarget.
    this.#cancellation = { signal: AbortSignal.abort(createDisposalReason()) };
    const detach = this.#detachFromParent;
    this.#detachFromParent = undefined;
    detach?.(this);
    const observer = this.#observer;
    this.#observer = undefined;
    observer?.changed?.();
  }

  #withdraw() {
    for (const record of [...this.#publications].reverse()) {
      if (record.withdraw()) this.#publications.delete(record);
      // A publication may detach before its withdrawal fails; the unfinished obligation still belongs here.
      else this.#publications.add(record);
    }
  }

  #own(cleanup: Cleanup, kind: CleanupKind, releaseClaim?: () => void) {
    const records = kind === "cleanup" ? this.#cleanups : this.#interrupts;
    const record: CleanupRecord = new CleanupRecord(++this.#sequence, kind, {
      cleanup,
      ...(releaseClaim && { releaseClaim }),
      detach: () => {
        records.delete(record);
        this.#changed();
      },
      releaseFailed: (error) => this.#notifyReleaseFailure(error, kind),
      changed: () => this.#changed(),
    });
    records.add(record);
    this.#changed();
    return record;
  }

  #changed() {
    this.#observer?.changed?.();
  }

  #reportError(error: unknown) {
    const observer = this.#observer;
    if (observer)
      assertSynchronous(observer.report(error), "Lifetime error reporters must be synchronous");
  }

  #notifyReleaseFailure(error: unknown, kind: ObligationKind) {
    this.#observer?.releaseFailed?.(Object.freeze({ owner: this, kind, error }));
  }

  // An accepting scope always still holds its observer; disposal drops both together.
  #requireActive(): LifetimeObserver {
    const observer = this.#observer;
    if (!this.acceptsWork || !observer) {
      throw new DougongError(lifetimeDisposedCode, "Lifetime is closed to new work");
    }
    return observer;
  }
}
