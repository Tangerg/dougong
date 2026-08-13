import type { Disposable, Readable } from "@dougong/reactive";
import type { Event, Extension } from "./contracts";
import type { Contribution } from "./extension-store";
import type { EventListener } from "./event-hub";

export interface Logger {
  debug(message: unknown, ...details: unknown[]): void;
  info(message: unknown, ...details: unknown[]): void;
  warn(message: unknown, ...details: unknown[]): void;
  error(message: unknown, ...details: unknown[]): void;
}

export interface PluginMeta {
  readonly app: string;
  readonly name: string;
  readonly instance: string;
}

export interface Task<T = void> extends Disposable {
  readonly result: Promise<T>;
}

export type Cleanup = () => unknown;
export type BackgroundTask<T> = (signal: AbortSignal) => T | PromiseLike<T>;
export type Observer<T> = (value: T, lifetime: LifetimeContext) => void;

export interface LifetimeOperations {
  readonly signal: AbortSignal;
  cleanup(dispose: Cleanup): Disposable;
  lifetime(): LifetimeContext;
  spawn<T>(task: BackgroundTask<T>): Task<T>;
  observe<T>(source: Readable<T>, observer: Observer<T>): Disposable;
  on<T>(token: Event<T>, listener: EventListener<T>): Disposable;
  emit<T>(token: Event<T>, payload: T): Promise<void>;
  contribute<T>(token: Extension<T>, key: string, value: T): Contribution<T>;
}

export interface LifetimeContext extends LifetimeOperations, Disposable {}

export interface LifetimeHost {
  readonly log: Logger;
  on<T>(token: Event<T>, listener: EventListener<T>): Disposable;
  emit<T>(token: Event<T>, payload: T): Promise<void>;
  contribute<T>(ownerId: string, token: Extension<T>, key: string, value: T): Contribution<T>;
  report(error: unknown): void;
}

function cleanupHandle(dispose: Cleanup): Disposable {
  let result: Promise<void> | undefined;
  let disposed = false;

  return {
    dispose() {
      if (disposed) return result;
      disposed = true;
      result = Promise.resolve()
        .then(dispose)
        .then(() => undefined);
      return result;
    },
  };
}

class TaskHandle<T> implements Task<T> {
  readonly #controller = new AbortController();
  readonly #removeParentListener: () => void;
  #disposePromise?: Promise<void>;

  readonly result: Promise<T>;

  constructor(
    parentSignal: AbortSignal,
    task: BackgroundTask<T>,
    report: (error: unknown) => void,
  ) {
    const abort = () => this.#controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#removeParentListener = () => parentSignal.removeEventListener("abort", abort);

    if (parentSignal.aborted) abort();

    this.result = Promise.resolve().then(() => task(this.#controller.signal));
    this.result.catch((error) => {
      if (!this.#controller.signal.aborted) report(error);
    });
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;

    this.#controller.abort();
    this.#removeParentListener();
    this.#disposePromise = this.result.then(
      () => undefined,
      () => undefined,
    );
    return this.#disposePromise;
  }
}

export class Lifetime implements LifetimeContext {
  readonly #controller = new AbortController();
  readonly #resources: Disposable[] = [];
  readonly #removeParentListener?: () => void;
  #phase: "active" | "disposing" | "disposed" = "active";
  #disposePromise?: Promise<void>;

  constructor(
    readonly host: LifetimeHost,
    readonly ownerId: string,
    parentSignal?: AbortSignal,
  ) {
    if (!parentSignal) return;

    const abort = () => this.#controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    this.#removeParentListener = () => parentSignal.removeEventListener("abort", abort);
    if (parentSignal.aborted) abort();
  }

  get signal() {
    return this.#controller.signal;
  }

  cleanup(dispose: Cleanup) {
    this.#assertActive();
    return this.adopt(cleanupHandle(dispose));
  }

  lifetime() {
    this.#assertActive();
    return this.adopt(new Lifetime(this.host, this.ownerId, this.signal));
  }

  spawn<T>(task: BackgroundTask<T>): Task<T> {
    this.#assertActive();
    return this.adopt(new TaskHandle(this.signal, task, (error) => this.host.report(error)));
  }

  observe<T>(source: Readable<T>, observer: Observer<T>): Disposable {
    this.#assertActive();

    let active = true;
    let scheduled = false;
    let revision = 0;
    let currentValue = source.get();
    let current = new Lifetime(this.host, this.ownerId, this.signal);
    let chain = Promise.resolve();

    const runObserver = (value: T, lifetime: Lifetime) => {
      try {
        const result = observer(value, lifetime) as unknown;
        if (result && typeof result === "object" && "then" in result) {
          Promise.resolve(result).catch((error) => this.host.report(error));
          throw new TypeError("Observers must be synchronous; use lifetime.spawn() for async work");
        }
      } catch (error) {
        lifetime.dispose().catch((cleanupError) => this.host.report(cleanupError));
        throw error;
      }
    };

    const schedule = () => {
      if (!active || scheduled) return;
      scheduled = true;

      queueMicrotask(() => {
        scheduled = false;
        if (!active) return;

        const nextValue = source.get();
        if (Object.is(currentValue, nextValue)) return;
        currentValue = nextValue;
        const runRevision = ++revision;

        chain = chain
          .then(async () => {
            await current.dispose();
            if (!active || runRevision !== revision) return;

            current = new Lifetime(this.host, this.ownerId, this.signal);
            runObserver(nextValue, current);
          })
          .catch((error) => this.host.report(error));
      });
    };

    const subscription = source.subscribe(schedule);

    try {
      runObserver(currentValue, current);
    } catch (error) {
      active = false;
      subscription.dispose();
      current.dispose().catch((cleanupError) => this.host.report(cleanupError));
      throw error;
    }

    return this.adopt({
      dispose: async () => {
        if (!active) return;
        active = false;
        revision++;
        subscription.dispose();
        await chain;
        await current.dispose();
      },
    });
  }

  on<T>(token: Event<T>, listener: EventListener<T>) {
    this.#assertActive();
    return this.adopt(this.host.on(token, listener));
  }

  emit<T>(token: Event<T>, payload: T) {
    if (this.#phase === "disposed") {
      throw new TypeError("Lifetime has been disposed");
    }
    return this.host.emit(token, payload);
  }

  contribute<T>(token: Extension<T>, key: string, value: T) {
    this.#assertActive();
    return this.adopt(this.host.contribute(this.ownerId, token, key, value));
  }

  adopt<T extends Disposable>(resource: T): T {
    this.#assertActive();
    this.#resources.push(resource);
    return resource;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;

    this.#phase = "disposing";

    this.#disposePromise = Promise.resolve()
      .then(async () => {
        const errors: unknown[] = [];

        for (const resource of this.#resources.splice(0).reverse()) {
          try {
            await resource.dispose();
          } catch (error) {
            errors.push(error);
          }
        }

        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Lifetime cleanup failed");
        }
      })
      .finally(() => {
        this.#phase = "disposed";
      });

    this.#controller.abort();
    this.#removeParentListener?.();

    return this.#disposePromise;
  }

  #assertActive() {
    if (this.#phase !== "active" || this.signal.aborted) {
      throw new TypeError("Lifetime is disposing or has been disposed");
    }
  }
}
