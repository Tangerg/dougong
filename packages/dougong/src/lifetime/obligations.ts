import { isCancellationReason } from "../contracts/errors.js";
import { RecordedFailure } from "../contracts/recorded-failure.js";
import {
  asyncDisposeSymbol,
  disposeSymbol,
  markOwnedControlHandle,
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
    const { cleanup, detach, releaseFailed, changed } = state.binding;
    const completion = Promise.withResolvers<void>();
    const receipt = Object.freeze(completion.promise);
    this.#state = { phase: "releasing", completion: receipt };
    void Promise.resolve()
      .then(() => resolveValue(cleanup()))
      .then(
        () => {
          this.#state = { phase: "released", completion: receipt };
          detach();
          completion.resolve();
        },
        (error: unknown) => {
          releaseFailed(error);
          this.#state = {
            phase: "failed",
            completion: receipt,
            failure: new RecordedFailure(error),
          };
          changed();
          completion.reject(error);
        },
      );
    return receipt;
  }

  forget() {
    const state = this.#state;
    if (state.phase !== "owned") return;
    this.#state = { phase: "forgotten" };
    state.binding.detach();
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
    const result = Promise.resolve().then(() => resolveValue(task(controller.signal)));
    this.settled = Object.freeze(
      result.then(
        () => this.#settle(),
        (error: unknown) => {
          failed(error);
          this.#settle();
        },
      ),
    );
    this.handle = markOwnedControlHandle(
      Object.freeze({
        result,
        // A bound method keeps the retained handle out of this constructor's closure context,
        // which still references the task function and its error reporter.
        [asyncDisposeSymbol]: this.#dispose.bind(this),
      }),
    );
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
