import { isCancellationReason } from "../contracts/errors.js";
import { RecordedFailure } from "../contracts/recorded-failure.js";
import {
  asyncDisposeSymbol,
  disposeSymbol,
  type AsyncDisposable,
  type Awaitable,
  type Publication,
} from "../contracts/resource.js";
import { assertSynchronous, resolveValue, type ResolvedValue } from "../internal/async-result.js";
import { batchSnapshotNotifications } from "../observation/snapshot-view.js";
import type { ObligationKind } from "./lifetime-diagnostics.js";

export type Cleanup = () => Awaitable<unknown>;
export type BackgroundTask<T> = (signal: AbortSignal) => Awaitable<T>;

export interface Task<T = void> extends AsyncDisposable {
  readonly result: Promise<ResolvedValue<T>>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type CleanupKind = Extract<ObligationKind, "cleanup" | "interrupt">;
export type CleanupProtocol = "synchronous" | "asynchronous";

export function createDisposalReason() {
  const reason = new DOMException("Resource disposed", "AbortError");
  // Independent cancellation needs its own identity, without retaining completed stack frames.
  Reflect.set(reason, "stack", undefined);
  return Object.freeze(reason);
}

interface CleanupBinding {
  readonly cleanup: Cleanup;
  readonly protocol: CleanupProtocol;
  readonly releaseClaim?: () => void;
  readonly detach: () => void;
  readonly releaseFailed: (error: unknown) => void;
  readonly changed: () => void;
}

interface ReleaseFailureRecord {
  readonly reason: unknown;
  recorded: RecordedFailure | undefined;
}

// A failed release keeps its record: retrying an arbitrary callback could repeat external effects.
// The availability authority hears of a failure before Core reads the error, whose accessors may run.
type CleanupState =
  | { readonly phase: "owned"; readonly binding: CleanupBinding }
  | { readonly phase: "releasing"; readonly completion: Promise<void> }
  | { readonly phase: "released"; readonly completion: Promise<void> }
  | {
      readonly phase: "failed";
      readonly completion: Promise<void>;
      readonly failure: ReleaseFailureRecord;
    }
  | { readonly phase: "forgotten" };

export class CleanupRecord {
  readonly id: number;
  readonly kind: CleanupKind;
  #state: CleanupState;

  constructor(id: number, kind: CleanupKind, binding: CleanupBinding) {
    this.id = id;
    this.kind = kind;
    this.#state = { phase: "owned", binding };
  }

  get failure() {
    const state = this.#state;
    return state.phase === "failed" ? state.failure.recorded : undefined;
  }

  dispose(): Promise<void> {
    const state = this.#state;
    if (state.phase === "forgotten") return Promise.resolve();
    if (state.phase !== "owned") return state.completion;
    if (state.binding.protocol === "synchronous") return this.#releaseSynchronously();
    const { cleanup, releaseClaim, detach } = state.binding;
    const completion = this.#beginRelease();
    void Promise.resolve()
      .then(() => resolveValue(cleanup()))
      .then(() => {
        releaseClaim?.();
      })
      .then(
        () => {
          this.#completeRelease(detach, completion);
        },
        (error: unknown) => this.#fail(state.binding, completion, error),
      );
    return completion.promise;
  }

  disposeSynchronously() {
    this.#releaseSynchronously();
    const state = this.#state;
    if (state.phase === "failed") throw state.failure.reason;
  }

  #releaseSynchronously(): Promise<void> {
    const state = this.#state;
    if (state.phase === "forgotten") return Promise.resolve();
    if (state.phase !== "owned") return state.completion;
    const completion = this.#beginRelease();
    void completion.promise.catch(() => undefined);
    try {
      assertSynchronous(state.binding.cleanup(), "Synchronous cleanup must not return a Promise");
      state.binding.releaseClaim?.();
    } catch (error) {
      this.#fail(state.binding, completion, error);
      return completion.promise;
    }
    this.#completeRelease(state.binding.detach, completion);
    return completion.promise;
  }

  #completeRelease(detach: () => void, completion: PromiseWithResolvers<void>) {
    this.#state = { phase: "released", completion: completion.promise };
    detach();
    completion.resolve();
  }

  forget() {
    const state = this.#state;
    if (state.phase !== "owned") return;
    const completion = this.#beginRelease();
    // Forgetting reports synchronously; shutdown may observe its retained receipt later.
    void completion.promise.catch(() => undefined);
    try {
      state.binding.releaseClaim?.();
    } catch (error) {
      this.#fail(state.binding, completion, error);
      throw error;
    }
    this.#state = { phase: "forgotten" };
    state.binding.detach();
    completion.resolve();
  }

  #beginRelease() {
    const completion = Promise.withResolvers<void>();
    Object.freeze(completion.promise);
    this.#state = { phase: "releasing", completion: completion.promise };
    return completion;
  }

  #fail(binding: CleanupBinding, completion: PromiseWithResolvers<void>, error: unknown) {
    const failure: ReleaseFailureRecord = { reason: error, recorded: undefined };
    this.#state = {
      phase: "failed",
      completion: completion.promise,
      failure,
    };
    binding.releaseFailed(error);
    failure.recorded = new RecordedFailure(error);
    binding.changed();
    completion.reject(error);
  }
}

interface PublicationBinding {
  readonly detach: () => void;
  readonly changed: () => void;
  readonly releaseFailed: (error: unknown) => void;
  readonly report: (error: unknown) => void;
}

type PublicationState =
  | { readonly phase: "creating" }
  | {
      readonly phase: "owned";
      readonly publication: Publication;
      readonly binding: PublicationBinding;
    }
  | { readonly phase: "withdrawing" | "withdrawn" }
  | {
      readonly phase: "failed";
      readonly publication: Publication;
      readonly failure: ReleaseFailureRecord;
    };

export class PublicationRecord<Handle extends object = object> {
  readonly id: number;
  readonly handle: Handle;
  #state: PublicationState = { phase: "creating" };

  constructor(
    id: number,
    create: (withdraw: () => void) => Publication & { readonly handle: Handle },
    binding: PublicationBinding,
  ) {
    this.id = id;
    const publication = create(this.#dispose.bind(this));
    this.handle = publication.handle;
    this.#state = { phase: "owned", publication, binding };
  }

  get failure() {
    const state = this.#state;
    return state.phase === "failed" ? state.failure : undefined;
  }

  publish() {
    const state = this.#state;
    if (state.phase === "owned") state.publication.publish();
  }

  withdraw() {
    const state = this.#state;
    if (state.phase === "creating") throw new TypeError("Publication is still being created");
    if (state.phase !== "owned") return;
    this.#state = { phase: "withdrawing" };
    batchSnapshotNotifications(() => {
      try {
        assertSynchronous(
          state.publication[disposeSymbol](),
          "Publication withdrawal must be synchronous",
        );
      } catch (error) {
        // Availability must close before diagnostic accessors can reenter application code.
        const failure: ReleaseFailureRecord = { reason: error, recorded: undefined };
        this.#state = { phase: "failed", publication: state.publication, failure };
        state.binding.releaseFailed(error);
        failure.recorded = new RecordedFailure(error);
        state.binding.changed();
        return;
      }
      this.#state = { phase: "withdrawn" };
      state.binding.detach();
      state.binding.changed();
    }, state.binding.report);
  }

  #dispose() {
    this.withdraw();
    const failure = this.failure;
    if (failure) throw failure.reason;
  }
}

export class TaskRecord<T> {
  readonly handle: Task<Awaited<T>>;
  readonly settled: Promise<void>;
  #controller: AbortController | undefined;
  #detach: (() => void) | undefined;
  #launch: { start(): void; fail(error: unknown): void } | undefined;

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
    const completion = Promise.withResolvers<ResolvedValue<Awaited<T>>>();
    const result = completion.promise;
    this.settled = Object.freeze(
      result.then(
        () => this.#settle(),
        (error: unknown) => {
          failed(error);
          this.#settle();
        },
      ),
    );
    this.#launch = {
      start() {
        void Promise.resolve()
          .then(() => resolveValue(task(controller.signal)))
          .then(completion.resolve, completion.reject);
      },
      fail(error) {
        reporter = undefined;
        completion.reject(error);
      },
    };
    this.handle = Object.freeze({
      result,
      // A bound method keeps the retained handle out of this constructor's closure context,
      // which still references the task function and its error reporter.
      [asyncDisposeSymbol]: this.#dispose.bind(this),
    });
  }

  start() {
    const launch = this.#launch;
    this.#launch = undefined;
    launch?.start();
  }

  failStart(error: unknown) {
    const launch = this.#launch;
    this.#launch = undefined;
    launch?.fail(error);
  }

  cancel(reason: unknown) {
    const controller = this.#controller;
    this.#controller = undefined;
    controller?.abort(reason);
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
}
