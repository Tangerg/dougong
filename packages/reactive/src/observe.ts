import type { AsyncDisposable, Disposable, Readable, Resource } from "./protocol";
import { assertSynchronous, isThenable } from "./sync-result";

export interface ObservationTask<T = void> extends AsyncDisposable {
  readonly result: Promise<T>;
}

export interface ObservationLifetime extends AsyncDisposable {
  cleanup(dispose: () => unknown): AsyncDisposable;
  lifetime(label: string): ObservationLifetime;
  spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>): ObservationTask<T>;
}

export interface ObservationOwner<Child extends ObservationLifetime = ObservationLifetime> {
  cleanup(dispose: () => unknown): AsyncDisposable;
  lifetime(label: string): Child;
  spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>): ObservationTask<T>;
}

export type Observer<T, Child extends ObservationLifetime> = (value: T, lifetime: Child) => void;

type ObservedValue<T> = { readonly present: false } | { readonly present: true; readonly value: T };

interface ObservationBinding<T, Child extends ObservationLifetime> {
  readonly owner: ObservationOwner<Child>;
  readonly source: Readable<T>;
  readonly observer: Observer<T, Child>;
}

type ObservationState<T, Child extends ObservationLifetime> =
  | {
      readonly phase: "active";
      readonly binding: ObservationBinding<T, Child>;
    }
  | { readonly phase: "stopped" | "disposed" };

class Observation<T, Child extends ObservationLifetime> {
  #state: ObservationState<T, Child>;
  #subscription: Disposable | undefined;
  #current: Child | undefined;
  #observed: ObservedValue<T> = { present: false };
  #dirty = false;
  #drainTask: ObservationTask | undefined;
  #wakeDrain: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(owner: ObservationOwner<Child>, source: Readable<T>, observer: Observer<T, Child>) {
    this.#state = { phase: "active", binding: { owner, source, observer } };
  }

  start() {
    const { owner, source } = this.#requireBinding();
    const value = source.get();
    const current = owner.lifetime("observation");
    assertObservationLifetime(current);
    this.#current = current;

    const subscription = source.subscribe(() => this.#invalidate());
    assertDisposable(subscription, "Readable.subscribe()");
    this.#subscription = subscription;

    this.#invokeObserver(value, current);
    this.#observed = { present: true, value };

    const runner = owner.spawn((signal) => this.#drain(signal));
    assertObservationTask(runner);
    this.#drainTask = runner;
    void runner.result.then(
      () => this.#releaseDrainTask(runner),
      () => this.#releaseDrainTask(runner),
    );
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = Promise.withResolvers<void>();
    this.#disposePromise = completion.promise;
    this.#releaseBinding("disposed");
    this.#wakeDrain?.();
    void this.#disposeResources().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #disposeResources() {
    const errors: unknown[] = [];
    await collect(this.#takeSubscription(), errors);
    await collect(this.#takeDrainTask(), errors);
    await collect(this.#takeCurrent(), errors);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Observation cleanup failed");
  }

  #invalidate() {
    if (this.#state.phase !== "active") return;
    this.#dirty = true;
    this.#wakeDrain?.();
  }

  async #drain(signal: AbortSignal) {
    try {
      while (this.#state.phase === "active" && !signal.aborted) {
        await this.#waitForInvalidation(signal);
        while (this.#state.phase === "active" && !signal.aborted && this.#dirty) {
          this.#dirty = false;
          await this.#replaceCurrent();
        }
      }
    } catch (error) {
      if (this.#state.phase !== "active") throw error;
      await this.#stop([error], "Observation stopped after a replacement failed");
    }
  }

  #waitForInvalidation(signal: AbortSignal) {
    if (this.#dirty || this.#state.phase !== "active" || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        if (this.#wakeDrain === wake) this.#wakeDrain = undefined;
        resolve();
      };
      this.#wakeDrain = wake;
      signal.addEventListener("abort", wake, { once: true });
      if (this.#dirty || this.#state.phase !== "active" || signal.aborted) wake();
    });
  }

  async #replaceCurrent() {
    if (this.#state.phase !== "active") return;
    const value = this.#state.binding.source.get();
    if (this.#observed.present && Object.is(value, this.#observed.value)) return;

    const previous = this.#takeCurrent();
    if (previous) {
      try {
        await previous.dispose();
      } catch (error) {
        if (this.#state.phase !== "active") throw error;
        return this.#stop(
          [error],
          "Observation stopped because the previous lifetime could not be disposed",
        );
      }
    }
    this.#observed = { present: false };
    if (this.#state.phase !== "active") return;

    const current = this.#state.binding.owner.lifetime("observation");
    assertObservationLifetime(current);
    this.#current = current;
    try {
      this.#invokeObserver(value, current);
    } catch (error) {
      const failed = this.#takeCurrent();
      try {
        if (failed) await failed.dispose();
      } catch (cleanupError) {
        if (this.#state.phase !== "active") {
          throw new AggregateError(
            [error, cleanupError],
            "Observation callback failed and its resources could not be cleaned up",
          );
        }
        return this.#stop(
          [error, cleanupError],
          "Observation callback failed and its resources could not be cleaned up",
        );
      }
      throw error;
    }

    if (this.#state.phase !== "active") return;
    this.#observed = { present: true, value };
  }

  #invokeObserver(value: T, lifetime: Child) {
    const result: unknown = this.#requireBinding().observer(value, lifetime);
    assertSynchronous(result, "Observers must be synchronous; use lifetime.spawn() for async work");
  }

  #takeSubscription() {
    const subscription = this.#subscription;
    this.#subscription = undefined;
    return subscription;
  }

  #takeCurrent() {
    const current = this.#current;
    this.#current = undefined;
    return current;
  }

  #takeDrainTask() {
    const runner = this.#drainTask;
    this.#drainTask = undefined;
    return runner;
  }

  #releaseDrainTask(runner: ObservationTask) {
    if (this.#drainTask === runner) this.#drainTask = undefined;
  }

  async #stop(errors: unknown[], message: string): Promise<never> {
    this.#releaseBinding("stopped");
    this.#wakeDrain?.();
    await collect(this.#takeSubscription(), errors);
    await collect(this.#takeCurrent(), errors);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, message);
  }

  #requireBinding() {
    const state = this.#state;
    if (state.phase !== "active") throw new Error("Observation is not active");
    return state.binding;
  }

  #releaseBinding(phase: "stopped" | "disposed") {
    this.#state = { phase };
    this.#observed = { present: false };
    this.#dirty = false;
  }
}

/**
 * Lifetime-aware synchronization built only from the public source and
 * Lifetime protocols. It is a reactive-layer combinator, not a Core hook.
 */
export function observe<T, Child extends ObservationLifetime>(
  owner: ObservationOwner<Child>,
  source: Readable<T>,
  observer: Observer<T, Child>,
): AsyncDisposable {
  if (!source || typeof source.get !== "function" || typeof source.subscribe !== "function") {
    throw new TypeError("observe() expects a readable source");
  }
  if (typeof observer !== "function") throw new TypeError("Observer must be a function");
  if (
    !owner ||
    typeof owner.cleanup !== "function" ||
    typeof owner.lifetime !== "function" ||
    typeof owner.spawn !== "function"
  ) {
    throw new TypeError("observe() expects an observation owner");
  }
  const observation = new Observation(owner, source, observer);
  const handle = owner.cleanup(() => observation.dispose());
  assertAsyncDisposable(handle, "ObservationOwner.cleanup()");
  try {
    observation.start();
    return handle;
  } catch (error) {
    // Mark the observation disposed immediately so a synchronous notification
    // cannot race the owner's rollback. The registered cleanup remains the
    // authoritative ownership path and observes the same idempotent promise.
    void observation.dispose().catch(() => undefined);
    throw error;
  }
}

function assertDisposable(value: unknown, source: string): asserts value is Disposable {
  if (
    !value ||
    typeof (value as Disposable).dispose !== "function" ||
    typeof (value as Disposable)[Symbol.dispose] !== "function"
  ) {
    throw new TypeError(`${source} must return a Disposable`);
  }
}

function assertAsyncDisposable(value: unknown, source: string): asserts value is AsyncDisposable {
  if (
    !value ||
    typeof (value as AsyncDisposable).dispose !== "function" ||
    typeof (value as AsyncDisposable)[Symbol.asyncDispose] !== "function"
  ) {
    throw new TypeError(`${source} must return an AsyncDisposable`);
  }
}

function assertObservationLifetime(value: unknown): asserts value is ObservationLifetime {
  if (
    !value ||
    typeof (value as ObservationLifetime).dispose !== "function" ||
    typeof (value as ObservationLifetime)[Symbol.asyncDispose] !== "function" ||
    typeof (value as ObservationLifetime).cleanup !== "function" ||
    typeof (value as ObservationLifetime).lifetime !== "function" ||
    typeof (value as ObservationLifetime).spawn !== "function"
  ) {
    throw new TypeError("ObservationOwner.lifetime() must return an ObservationLifetime");
  }
}

function assertObservationTask(value: unknown): asserts value is ObservationTask {
  if (
    !value ||
    typeof (value as ObservationTask).dispose !== "function" ||
    typeof (value as ObservationTask)[Symbol.asyncDispose] !== "function" ||
    !isThenable((value as ObservationTask).result)
  ) {
    throw new TypeError("ObservationOwner.spawn() must return an ObservationTask");
  }
}

async function collect(resource: Resource | undefined, errors: unknown[]) {
  if (!resource) return;
  try {
    await resource.dispose();
  } catch (error) {
    errors.push(error);
  }
}
