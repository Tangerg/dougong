import {
  asyncDisposeSymbol,
  disposeSymbol,
  type AsyncDisposable,
  type Disposable,
  type Readable,
} from "./protocol";
import { assertSynchronous, captureThenable } from "./sync-result";

// Serialize replacement so the previous resource owner finishes before the next observer begins.

export interface ObservationTask<T = void> extends AsyncDisposable {
  readonly result: Promise<T>;
}

export interface ObservationOwner<Child extends AsyncDisposable = AsyncDisposable> {
  readonly cleanup: (dispose: () => unknown) => AsyncDisposable;
  readonly lifetime: (label: string) => Child;
  readonly spawn: <T>(task: (signal: AbortSignal) => T | PromiseLike<T>) => ObservationTask<T>;
}

export type Observer<T, Child extends AsyncDisposable> = (value: T, lifetime: Child) => void;

type ObservedValue<T> = { readonly present: false } | { readonly present: true; readonly value: T };

interface ObservationBinding<T, Child extends AsyncDisposable> {
  readonly owner: ObservationOwner<Child>;
  readonly source: Readable<T>;
  readonly observer: Observer<T, Child>;
}

type ObservationState<T, Child extends AsyncDisposable> =
  | {
      readonly phase: "active";
      readonly binding: ObservationBinding<T, Child>;
    }
  | { readonly phase: "stopped" | "disposed" };

class Observation<T, Child extends AsyncDisposable> {
  #state: ObservationState<T, Child>;
  #subscription: Disposable | undefined;
  #current: Child | undefined;
  #observed: ObservedValue<T> = { present: false };
  #dirty = false;
  #drainTask: ObservationTask | undefined;
  #ownerCleanup: AsyncDisposable | undefined;
  #wakeDrain: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(owner: ObservationOwner<Child>, source: Readable<T>, observer: Observer<T, Child>) {
    this.#state = { phase: "active", binding: { owner, source, observer } };
  }

  start() {
    const { owner, source } = this.#requireBinding();
    const subscription = source.subscribe(() => this.#invalidate());
    assertDisposable(subscription, "Readable.subscribe()");
    if (this.#state.phase !== "active") {
      disposeSubscription(subscription);
      throw new Error("Observation is not active");
    }
    this.#subscription = subscription;

    this.#createCurrent();

    const runner = owner.spawn((signal) => this.#drain(signal));
    const result = captureObservationTaskResult(runner);
    this.#drainTask = runner;
    void result.then(
      () => this.#releaseDrainTask(runner),
      () => this.#releaseDrainTask(runner),
    );
  }

  attachOwnerCleanup(cleanup: AsyncDisposable) {
    this.#ownerCleanup = cleanup;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = Promise.withResolvers<void>();
    this.#disposePromise = completion.promise;
    this.#ownerCleanup = undefined;
    this.#releaseBinding("disposed");
    this.#wakeDrain?.();
    void this.#disposeResources().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #disposeResources() {
    const errors: unknown[] = [];
    // Finish synchronous factory handoffs before draining their returned resources.
    await this.#disposeSubscription(errors);
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

  // Stop on drain failure because continuing would observe a value whose resource ownership never established.
  async #drain(signal: AbortSignal) {
    try {
      while (this.#state.phase === "active" && !signal.aborted) {
        await this.#waitForInvalidation(signal);
        while (this.#state.phase === "active" && !signal.aborted && this.#dirty) {
          this.#dirty = false;
          await this.#replaceCurrent(signal);
        }
      }
    } catch (error) {
      if (this.#state.phase !== "active") throw error;
      await this.#stop(error);
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

  // Clear the observed marker during replacement so interruption cannot leave a value without its owner.
  async #replaceCurrent(signal: AbortSignal) {
    if (this.#state.phase !== "active" || signal.aborted) return;
    const beforeCleanup = this.#state.binding.source.get();
    // Notifications can preserve the value; compare again before tearing down its live resources.
    if (this.#observed.present && Object.is(beforeCleanup, this.#observed.value)) return;

    const previous = this.#takeCurrent();
    if (previous) await previous.dispose();
    this.#observed = { present: false };
    if (this.#state.phase !== "active" || signal.aborted) return;

    this.#createCurrent();
  }

  #createCurrent() {
    const { owner, source } = this.#requireBinding();
    const current = owner.lifetime("observation");
    assertAsyncDisposable(current, "ObservationOwner.lifetime()");
    this.#current = current;
    // Creating a child can synchronously change the source, so subscribe before ownership and read afterward.
    const value = source.get();
    this.#invokeObserver(value, current);

    if (this.#state.phase !== "active") return;
    this.#observed = { present: true, value };
  }

  #invokeObserver(value: T, lifetime: Child) {
    const result: unknown = this.#requireBinding().observer(value, lifetime);
    assertSynchronous(result, "Observers must be synchronous; use owner.spawn() for async work");
  }

  async #disposeSubscription(errors: unknown[]) {
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (!subscription) return;
    try {
      disposeSubscription(subscription);
    } catch (error) {
      errors.push(error);
    }
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

  #takeOwnerCleanup() {
    const cleanup = this.#ownerCleanup;
    this.#ownerCleanup = undefined;
    return cleanup;
  }

  #releaseDrainTask(runner: ObservationTask) {
    if (this.#drainTask === runner) this.#drainTask = undefined;
  }

  async #stop(error: unknown): Promise<never> {
    const errors = [error];
    this.#releaseBinding("stopped");
    this.#wakeDrain?.();
    await this.#disposeSubscription(errors);
    await collect(this.#takeCurrent(), errors);
    // Detach the current drain task before cleanup so disposal cannot await itself.
    this.#drainTask = undefined;
    await collect(this.#takeOwnerCleanup(), errors);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Observation stopped after a replacement failed");
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

export function observe<T, Child extends AsyncDisposable>(
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
  observation.attachOwnerCleanup(handle);
  try {
    observation.start();
    return handle;
  } catch (error) {
    // Owner rollback still owns async cleanup failure when construction never returned a handle.
    void observation.dispose().catch(() => undefined);
    throw error;
  }
}

function assertDisposable(value: unknown, source: string): asserts value is Disposable {
  if (
    !value ||
    typeof (value as Disposable).dispose !== "function" ||
    typeof (value as Disposable)[disposeSymbol] !== "function"
  ) {
    throw new TypeError(`${source} must return a Disposable`);
  }
}

function assertAsyncDisposable(value: unknown, source: string): asserts value is AsyncDisposable {
  if (
    !value ||
    typeof (value as AsyncDisposable).dispose !== "function" ||
    typeof (value as AsyncDisposable)[asyncDisposeSymbol] !== "function"
  ) {
    throw new TypeError(`${source} must return an AsyncDisposable`);
  }
}

function captureObservationTaskResult(value: unknown): Promise<unknown> {
  const result =
    value &&
    typeof (value as ObservationTask).dispose === "function" &&
    typeof (value as ObservationTask)[asyncDisposeSymbol] === "function"
      ? captureThenable((value as ObservationTask).result)
      : undefined;
  if (!result) {
    throw new TypeError("ObservationOwner.spawn() must return an ObservationTask");
  }
  return result;
}

function disposeSubscription(subscription: Disposable) {
  assertSynchronous(subscription.dispose(), "Readable subscriptions must dispose synchronously");
}

async function collect(resource: AsyncDisposable | undefined, errors: unknown[]) {
  if (!resource) return;
  try {
    await resource.dispose();
  } catch (error) {
    errors.push(error);
  }
}
