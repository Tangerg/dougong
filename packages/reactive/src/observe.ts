import type { Disposable, Readable } from "./protocol";

export interface ObservationTask<T = void> extends Disposable {
  readonly result: Promise<T>;
}

export interface ObservationLifetime extends Disposable {
  cleanup(dispose: () => unknown): Disposable;
  lifetime(label: string): ObservationLifetime;
  spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>): ObservationTask<T>;
}

export interface ObservationOwner<Child extends ObservationLifetime = ObservationLifetime> {
  cleanup(dispose: () => unknown): Disposable;
  lifetime(label: string): Child;
  spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>): ObservationTask<T>;
}

export type Observer<T, Child extends ObservationLifetime> = (value: T, lifetime: Child) => void;

class Observation<T, Child extends ObservationLifetime> implements Disposable {
  readonly #owner: ObservationOwner<Child>;
  readonly #source: Readable<T>;
  readonly #observer: Observer<T, Child>;
  #subscription: Disposable | undefined;
  #current: Child | undefined;
  #value!: T;
  #hasValue = false;
  #dirty = false;
  #phase: "active" | "stopped" | "disposed" = "active";
  #drainTask: ObservationTask | undefined;
  #wakeDrain: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(owner: ObservationOwner<Child>, source: Readable<T>, observer: Observer<T, Child>) {
    this.#owner = owner;
    this.#source = source;
    this.#observer = observer;
  }

  start() {
    const value = this.#source.get();
    const current = this.#owner.lifetime("observation");
    assertObservationLifetime(current);
    this.#current = current;

    const subscription = this.#source.subscribe(() => this.#invalidate());
    assertDisposable(subscription, "Readable.subscribe()");
    this.#subscription = subscription;

    this.#invokeObserver(value, current);
    this.#value = value;
    this.#hasValue = true;

    const runner = this.#owner.spawn((signal) => this.#drain(signal));
    assertObservationTask(runner);
    this.#drainTask = runner;
    void runner.result.then(
      () => this.#releaseDrainTask(runner),
      () => this.#releaseDrainTask(runner),
    );
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#phase = "disposed";
    this.#wakeDrain?.();
    this.#disposePromise = (async () => {
      const errors: unknown[] = [];
      await collect(this.#takeSubscription(), errors);
      await collect(this.#takeDrainTask(), errors);
      await collect(this.#takeCurrent(), errors);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Observation cleanup failed");
    })();
    return this.#disposePromise;
  }

  #invalidate() {
    if (this.#phase !== "active") return;
    this.#dirty = true;
    this.#wakeDrain?.();
  }

  async #drain(signal: AbortSignal) {
    try {
      while (this.#phase === "active" && !signal.aborted) {
        await this.#waitForInvalidation(signal);
        while (this.#phase === "active" && !signal.aborted && this.#dirty) {
          this.#dirty = false;
          await this.#replaceCurrent();
        }
      }
    } catch (error) {
      if (this.#phase === "stopped") throw error;
      await this.#stop([error], "Observation stopped after a replacement failed");
    }
  }

  #waitForInvalidation(signal: AbortSignal) {
    if (this.#dirty || this.#phase !== "active" || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        if (this.#wakeDrain === wake) this.#wakeDrain = undefined;
        resolve();
      };
      this.#wakeDrain = wake;
      signal.addEventListener("abort", wake, { once: true });
      if (this.#dirty || this.#phase !== "active" || signal.aborted) wake();
    });
  }

  async #replaceCurrent() {
    if (this.#phase !== "active") return;
    const value = this.#source.get();
    if (this.#hasValue && Object.is(value, this.#value)) return;

    const previous = this.#takeCurrent();
    if (previous) {
      try {
        await previous.dispose();
      } catch (error) {
        return this.#stop(
          [error],
          "Observation stopped because the previous lifetime could not be disposed",
        );
      }
    }
    this.#hasValue = false;
    if (this.#phase !== "active") return;

    const current = this.#owner.lifetime("observation");
    assertObservationLifetime(current);
    try {
      this.#invokeObserver(value, current);
    } catch (error) {
      try {
        await current.dispose();
      } catch (cleanupError) {
        return this.#stop(
          [error, cleanupError],
          "Observation callback failed and its resources could not be cleaned up",
        );
      }
      throw error;
    }

    this.#current = current;
    this.#value = value;
    this.#hasValue = true;
  }

  #invokeObserver(value: T, lifetime: Child) {
    const result: unknown = this.#observer(value, lifetime);
    if (!isThenable(result)) return;
    Promise.resolve(result).catch(() => undefined);
    throw new TypeError("Observers must be synchronous; use lifetime.spawn() for async work");
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
    this.#phase = "stopped";
    this.#wakeDrain?.();
    await collect(this.#takeSubscription(), errors);
    await collect(this.#takeCurrent(), errors);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, message);
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
): Disposable {
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
  assertDisposable(handle, "ObservationOwner.cleanup()");
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
  if (!value || typeof (value as Disposable).dispose !== "function") {
    throw new TypeError(`${source} must return a Disposable`);
  }
}

function assertObservationLifetime(value: unknown): asserts value is ObservationLifetime {
  if (
    !value ||
    typeof (value as ObservationLifetime).dispose !== "function" ||
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
    !isThenable((value as ObservationTask).result)
  ) {
    throw new TypeError("ObservationOwner.spawn() must return an ObservationTask");
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && "then" in value
  );
}

async function collect(resource: Disposable | undefined, errors: unknown[]) {
  if (!resource) return;
  try {
    await resource.dispose();
  } catch (error) {
    errors.push(error);
  }
}
