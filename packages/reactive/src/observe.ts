import {
  asyncDisposeSymbol,
  captureReadable,
  captureUnsubscribe,
  type AsyncDisposable,
  type Readable,
} from "./protocol.js";
import { assertSynchronous, captureThenable } from "./sync-result.js";

// Serialize replacement so the previous resource owner finishes before the next observer begins.

export interface ObservationTask<T = void> extends AsyncDisposable {
  readonly result: Promise<T>;
}

export interface ObservationOwner<Child extends AsyncDisposable = AsyncDisposable> {
  readonly defer: (dispose: () => unknown) => AsyncDisposable;
  readonly child: (label: string) => Child;
  readonly spawn: <T>(task: (signal: AbortSignal) => T | PromiseLike<T>) => ObservationTask<T>;
}

export type Observer<T, Child extends AsyncDisposable> = (value: T, lifetime: Child) => void;

type Release = () => PromiseLike<void>;

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
  #unsubscribe: (() => void) | undefined;
  #current: Release | undefined;
  #currentRelease: Promise<void> | undefined;
  #starting = false;
  #observed: ObservedValue<T> = { present: false };
  #dirty = false;
  #drainTask: Release | undefined;
  #ownerCleanup: Release | undefined;
  #wakeDrain: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(owner: ObservationOwner<Child>, source: Readable<T>, observer: Observer<T, Child>) {
    this.#state = { phase: "active", binding: { owner, source, observer } };
  }

  start() {
    this.#starting = true;
    try {
      this.#attach();
    } finally {
      this.#starting = false;
    }
  }

  #attach() {
    const { owner, source } = this.#requireBinding();
    this.#unsubscribe = captureUnsubscribe(source.subscribe(() => this.#invalidate()));

    this.#createCurrent();

    const runner = owner.spawn((signal) => this.#drain(signal));
    const cancel = captureRelease(
      runner,
      "ObservationOwner.spawn() must return an ObservationTask",
    );
    // Once cancellation is available, rollback owns the runner even if its result is malformed.
    this.#drainTask = cancel;
    const result = captureThenable(runner.result);
    if (!result) throw new TypeError("ObservationOwner.spawn() must return an ObservationTask");
    void result.then(
      () => this.#releaseDrainTask(cancel),
      () => this.#releaseDrainTask(cancel),
    );
  }

  attachOwnerCleanup(cleanup: Release) {
    this.#ownerCleanup = cleanup;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = Promise.withResolvers<void>();
    this.#disposePromise = completion.promise;
    this.#ownerCleanup = undefined;
    this.#releaseBinding("disposed");
    this.#wakeDrain?.();
    // A reentrant close must also join resources the active factory has not returned yet.
    const work = this.#starting
      ? Promise.resolve().then(() => this.#disposeResources())
      : this.#disposeResources();
    void work.then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #disposeResources() {
    const errors: unknown[] = [];
    try {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
    } catch (error) {
      errors.push(error);
    }
    await collect(this.#takeDrainTask(), errors);
    try {
      await this.#releaseCurrent();
    } catch (error) {
      errors.push(error);
    }
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
      try {
        await this.#stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Observation stopped after a replacement failed",
        );
      }
      throw error;
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

    try {
      await this.#releaseCurrent();
    } catch (error) {
      // Disposal joins this exact release; its rejection already includes the failed child.
      if (this.#state.phase === "active") await this.#stop();
      throw error;
    }
    this.#observed = { present: false };
    if (this.#state.phase !== "active" || signal.aborted) return;

    this.#createCurrent();
  }

  #createCurrent() {
    const { owner } = this.#requireBinding();
    const current = owner.child("observation");
    this.#current = captureRelease(
      current,
      "ObservationOwner.child() must return an AsyncDisposable",
    );
    // Creating a child can synchronously change the source, so subscribe before ownership and read afterward.
    const value = this.#requireBinding().source.get();
    this.#invokeObserver(value, current);

    if (this.#state.phase !== "active") return;
    this.#observed = { present: true, value };
  }

  #invokeObserver(value: T, lifetime: Child) {
    const { observer } = this.#requireBinding();
    const result: unknown = observer(value, lifetime);
    assertSynchronous(result, "Observers must be synchronous; use owner.spawn() for async work");
  }

  #releaseCurrent() {
    const current = this.#current;
    if (!current) return;
    // Replacement and terminal shutdown share the same attempt, including its rejection.
    return (this.#currentRelease ??= Promise.resolve()
      .then(current)
      .then(() => {
        this.#current = undefined;
        this.#currentRelease = undefined;
      }));
  }

  #takeDrainTask() {
    const runner = this.#drainTask;
    this.#drainTask = undefined;
    return runner;
  }

  #releaseDrainTask(runner: Release) {
    if (this.#drainTask === runner) this.#drainTask = undefined;
  }

  async #stop() {
    this.#releaseBinding("stopped");
    // The drain is the caller here; joining it from the owner's cleanup would wait on itself.
    this.#drainTask = undefined;
    const cleanup = this.#ownerCleanup;
    if (cleanup) await cleanup();
    else await this.dispose();
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
  const readable = captureReadable(source, "observe()");
  if (typeof observer !== "function") throw new TypeError("Observer must be a function");
  const defer = owner?.defer;
  const child = owner?.child;
  const spawn = owner?.spawn;
  if (typeof defer !== "function" || typeof child !== "function" || typeof spawn !== "function") {
    throw new TypeError("observe() expects an observation owner");
  }
  const binding = { defer: defer.bind(owner), child: child.bind(owner), spawn: spawn.bind(owner) };
  const observation = new Observation(binding, readable, observer);
  const close = captureRelease(
    binding.defer(() => observation.dispose()),
    "ObservationOwner.defer() must return an AsyncDisposable",
  );
  observation.attachOwnerCleanup(close);
  try {
    observation.start();
    return Object.freeze({ [asyncDisposeSymbol]: close });
  } catch (error) {
    // Roll back the owner's registration as well as the subscription; failed cleanup stays owned.
    try {
      void Promise.resolve(close()).catch(() => undefined);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Observation construction failed");
    }
    throw error;
  }
}

function captureRelease(value: AsyncDisposable, message: string): Release {
  const release = value?.[asyncDisposeSymbol];
  if (typeof release !== "function") throw new TypeError(message);
  return () => Reflect.apply(release, value, []);
}

async function collect(resource: Release | undefined, errors: unknown[]) {
  if (!resource) return;
  try {
    await resource();
  } catch (error) {
    errors.push(error);
  }
}
