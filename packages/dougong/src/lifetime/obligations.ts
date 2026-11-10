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
import type { ObligationKind } from "./lifetime-diagnostics.js";

export type Cleanup = () => Awaitable<unknown>;
export type BackgroundTask<T> = (signal: AbortSignal) => Awaitable<T>;

export interface Task<T = void> extends AsyncDisposable {
  readonly result: Promise<ResolvedValue<T>>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type CleanupKind = Extract<ObligationKind, "cleanup" | "interrupt">;

export function createDisposalReason() {
  const reason = new DOMException("Resource disposed", "AbortError");
  // Independent cancellation needs its own identity, without retaining completed stack frames.
  Reflect.set(reason, "stack", undefined);
  return Object.freeze(reason);
}

interface CleanupBinding {
  readonly cleanup: Cleanup;
  readonly releaseClaim?: () => void;
  readonly detach: () => void;
  readonly releaseFailed: (error: unknown) => void;
  readonly changed: () => void;
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
      readonly failure: RecordedFailure;
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
    return state.phase === "failed" ? state.failure : undefined;
  }

  dispose(): Promise<void> {
    const state = this.#state;
    if (state.phase === "forgotten") return Promise.resolve();
    if (state.phase !== "owned") return state.completion;
    const { cleanup, releaseClaim, detach } = state.binding;
    const completion = this.#beginRelease();
    void Promise.resolve()
      .then(() => resolveValue(cleanup()))
      .then(() => {
        releaseClaim?.();
      })
      .then(
        () => {
          this.#state = { phase: "released", completion: completion.promise };
          detach();
          completion.resolve();
        },
        (error: unknown) => this.#fail(state.binding, completion, error),
      );
    return completion.promise;
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
    binding.releaseFailed(error);
    this.#state = {
      phase: "failed",
      completion: completion.promise,
      failure: new RecordedFailure(error),
    };
    binding.changed();
    completion.reject(error);
  }
}

export class PublicationRecord {
  readonly id: number;
  readonly publication: Publication;
  // Marked failed before notification so a reentrant detach keeps it; recorded only afterwards.
  #failure: { readonly reason: unknown; recorded: RecordedFailure | undefined } | undefined;
  #releaseFailed: ((error: unknown) => void) | undefined;

  constructor(id: number, publication: Publication, releaseFailed: (error: unknown) => void) {
    this.id = id;
    this.publication = publication;
    this.#releaseFailed = releaseFailed;
  }

  get failure() {
    return this.#failure;
  }

  withdraw(): boolean {
    if (this.#failure) return false;
    try {
      assertSynchronous(
        this.publication[disposeSymbol](),
        "Publication withdrawal must be synchronous",
      );
    } catch (error) {
      const failure: { readonly reason: unknown; recorded: RecordedFailure | undefined } = {
        reason: error,
        recorded: undefined,
      };
      this.#failure = failure;
      this.#releaseFailed?.(error);
      failure.recorded = new RecordedFailure(error);
      return false;
    }
    this.#releaseFailed = undefined;
    return true;
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
