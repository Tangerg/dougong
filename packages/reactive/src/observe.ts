import {
  asyncDisposeSymbol,
  disposeSymbol,
  type AsyncDisposable,
  type Disposable,
  type Readable,
  type Resource,
} from "./protocol";
import { assertSynchronous, isThenable } from "./sync-result";

// `observe()` — the bridge between a changing value and structured ownership.
//
// The idea: each observed value gets its own child lifetime. When the value
// changes, that lifetime is disposed and a fresh one is created for the new
// value. So an observer can create tasks, listeners and cleanups freely and
// never write teardown code — the lifetime it was handed *is* the teardown.
//
// The owner is described structurally (`cleanup`/`lifetime`/`spawn`), not as a
// Core type. A Core `Lifetime` satisfies it, and so does a test double. That is
// why this lives in @dougongjs/reactive and yet composes with Core: it is a
// combinator over two public protocols, not a privileged hook.
//
// Replacement is serialized through a drain loop rather than done inline in the
// subscription callback. Disposing the previous lifetime is asynchronous, and two
// rapid changes must not overlap two teardowns — the loop guarantees the previous
// lifetime is fully gone before the next observer call.
//
// The `assert*` helpers at the bottom check the owner's return values because the
// owner is a caller-supplied object. A `lifetime()` that returns something
// undisposable would leak silently, so it is rejected at the boundary instead.

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
    this.#subscription = subscription;

    this.#createCurrent();

    const runner = owner.spawn((signal) => this.#drain(signal));
    assertObservationTask(runner);
    this.#drainTask = runner;
    void runner.result.then(
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

  /**
   * The serialization point. Sleeps until invalidated, then replaces the current
   * lifetime, repeating while the value keeps changing. The inner loop collapses
   * a burst of changes into one replacement per settled value rather than one per
   * notification.
   *
   * A failure here stops the observation and reports it. There is no caller to
   * return to — this runs in a spawned task — so continuing would mean silently
   * observing a value with a lifetime that failed to establish.
   */
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

  /**
   * Dispose the old lifetime, then create the new one, then call the observer.
   * Strictly in that order: overlapping them would run two owners of whatever the
   * observer set up, and a failed observer would leave the previous lifetime half
   * disposed.
   *
   * `#observed` is cleared while no lifetime is current, so an interrupted
   * replacement cannot leave a value marked as observed when nothing is
   * observing it.
   */
  async #replaceCurrent() {
    if (this.#state.phase !== "active") return;
    const beforeCleanup = this.#state.binding.source.get();
    // A notification does not guarantee a different value. Re-reading and
    // comparing avoids tearing down a live lifetime to rebuild an identical one.
    if (this.#observed.present && Object.is(beforeCleanup, this.#observed.value)) return;

    const previous = this.#takeCurrent();
    if (previous) await previous.dispose();
    this.#observed = { present: false };
    if (this.#state.phase !== "active") return;

    this.#createCurrent();
  }

  #createCurrent() {
    const { owner, source } = this.#requireBinding();
    const current = owner.lifetime("observation");
    assertAsyncDisposable(current, "ObservationOwner.lifetime()");
    this.#current = current;
    // Subscribe before establishing ownership, then read after it. Creating a
    // child can publish diagnostics and synchronously change the source too.
    const value = source.get();
    this.#invokeObserver(value, current);

    if (this.#state.phase !== "active") return;
    this.#observed = { present: true, value };
  }

  #invokeObserver(value: T, lifetime: Child) {
    const result: unknown = this.#requireBinding().observer(value, lifetime);
    assertSynchronous(result, "Observers must be synchronous; use owner.spawn() for async work");
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
    await collect(this.#takeSubscription(), errors);
    await collect(this.#takeCurrent(), errors);
    // The current drain task cannot await its own disposal. Release that edge
    // before disposing the cleanup handle that owns this Observation.
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

/**
 * Lifetime-aware synchronization built only from the public source and
 * Lifetime protocols. It is a reactive-layer combinator, not a Core hook.
 */
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
    // Dispose immediately so synchronous setup rollback cannot race live work.
    // The owner cleanup remains authoritative because construction did not
    // return a handle; owner rollback must still observe async cleanup failure.
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

function assertObservationTask(value: unknown): asserts value is ObservationTask {
  if (
    !value ||
    typeof (value as ObservationTask).dispose !== "function" ||
    typeof (value as ObservationTask)[asyncDisposeSymbol] !== "function" ||
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
