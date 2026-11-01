import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, type Logger } from "dougong";
import {
  observe,
  bridge,
  signal,
  type ObservationOwner,
  type Readable,
  type AsyncDisposable,
  type Disposable,
} from "@dougongjs/reactive";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function disposable(dispose: () => void): Disposable {
  return { [Symbol.dispose]: dispose };
}

function asyncDisposable(dispose: () => PromiseLike<void>): AsyncDisposable {
  return { [Symbol.asyncDispose]: dispose };
}

class ControlledReadable<T> implements Readable<T> {
  readonly #listeners = new Set<() => void>();
  value: T;
  getError: unknown;
  subscribeError: unknown;
  subscriptionsDisposed = 0;

  constructor(value: T) {
    this.value = value;
  }

  get() {
    if (this.getError !== undefined) {
      const error = this.getError;
      this.getError = undefined;
      throw error;
    }
    return this.value;
  }

  subscribe(listener: () => void): Disposable {
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.#listeners.add(listener);
    let active = true;
    return disposable(() => {
      if (!active) return;
      active = false;
      this.subscriptionsDisposed++;
      this.#listeners.delete(listener);
    });
  }

  notify() {
    for (const listener of [...this.#listeners]) listener();
  }
}

function logger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? [error, ...error.errors.flatMap((nested) => errorTree(nested))]
    : error instanceof Error && error.cause !== undefined
      ? [error, ...errorTree(error.cause)]
      : [error];
}

function manualOwner(
  child: AsyncDisposable,
  onLifetime: (label: string) => void = () => undefined,
): ObservationOwner {
  return {
    defer(dispose) {
      let active = true;
      const release = async () => {
        if (!active) return;
        active = false;
        await dispose();
      };
      return asyncDisposable(release);
    },
    child: (label) => {
      onLifetime(label);
      return child;
    },
    spawn: (task) => {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => task(controller.signal));
      const dispose = () => {
        controller.abort();
        return result.then(
          () => undefined,
          () => undefined,
        );
      };
      return {
        result,
        ...asyncDisposable(dispose),
      };
    },
  };
}

it("keeps the captured Task completion authoritative until observation disposal", async () => {
  const child = asyncDisposable(async () => undefined);
  const baseOwner = manualOwner(child);
  const taskDisposed = vi.fn<() => void>();
  let reads = 0;
  let completion!: Promise<unknown>;
  const owner: ObservationOwner = {
    ...baseOwner,
    spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>) {
      const runner = baseOwner.spawn(task);
      completion = runner.result;
      const dispose = () => {
        taskDisposed();
        return runner[Symbol.asyncDispose]();
      };
      return {
        get result() {
          return ++reads === 1 ? runner.result : Promise.resolve(undefined as T);
        },
        [Symbol.asyncDispose]: dispose,
      };
    },
  };
  const observation = observe(owner, signal(0), () => undefined);
  await tick();
  await observation[Symbol.asyncDispose]();
  await completion;

  expect(taskDisposed).toHaveBeenCalledOnce();
  expect(reads).toBe(1);
});

function manualLifetime(dispose: () => void | PromiseLike<void>): AsyncDisposable {
  const release = async () => {
    await dispose();
  };
  const child: AsyncDisposable = asyncDisposable(release);
  return child;
}

describe("observe composition", () => {
  it("drains a Task handed back by a factory that closed the observation", async () => {
    const base = manualOwner(manualLifetime(() => undefined));
    let cleanup!: AsyncDisposable;
    let closing!: PromiseLike<void>;
    let releaseTask!: ReturnType<typeof vi.fn<() => PromiseLike<void>>>;
    const owner: ObservationOwner = {
      ...base,
      defer(dispose) {
        cleanup = base.defer(dispose);
        return cleanup;
      },
      spawn(task) {
        const runner = base.spawn(task);
        releaseTask = vi.fn<() => PromiseLike<void>>(() => runner[Symbol.asyncDispose]());
        closing = cleanup[Symbol.asyncDispose]();
        return { result: runner.result, ...asyncDisposable(releaseTask) };
      },
    };

    observe(owner, signal(1), () => undefined);
    await closing;
    expect(releaseTask).toHaveBeenCalledOnce();
  });

  it.each(["dispose", "stop"] as const)(
    "rejects asynchronous source unsubscription during %s and still releases the child",
    async (phase) => {
      const releaseChild = vi.fn<() => void>();
      const base = manualOwner(manualLifetime(releaseChild));
      let runnerResult!: Promise<void>;
      const owner: ObservationOwner = {
        ...base,
        spawn(task) {
          const runner = base.spawn(task);
          runnerResult = runner.result as Promise<void>;
          return runner;
        },
      };
      const readFailure = new Error("source read failed");
      const unsubscription = Promise.withResolvers<void>();
      let failed = false;
      let notify!: () => void;
      const source: Readable<number> = {
        get() {
          if (failed) throw readFailure;
          return 1;
        },
        subscribe(listener) {
          notify = listener;
          return disposable(() => unsubscription.promise);
        },
      };
      const handle = observe(owner, source, () => undefined);
      await Promise.resolve();

      let completion: Promise<unknown>;
      if (phase === "dispose") {
        completion = Promise.resolve(handle[Symbol.asyncDispose]()).catch(
          (error: unknown) => error,
        );
      } else {
        failed = true;
        notify();
        completion = runnerResult.catch((error: unknown) => error);
      }
      await tick();
      try {
        expect(releaseChild).toHaveBeenCalledOnce();
      } finally {
        unsubscription.reject(new Error("async unsubscription failed"));
      }
      const failure = await completion;
      expect(failure).toBeInstanceOf(phase === "dispose" ? TypeError : AggregateError);
      const errors = phase === "dispose" ? [failure] : (failure as AggregateError).errors;
      expect(errors).toEqual([
        ...(phase === "stop" ? [readFailure] : []),
        new TypeError("Readable subscriptions must dispose synchronously"),
      ]);
      if (phase === "stop") await handle[Symbol.asyncDispose]();
    },
  );

  it.each([undefined, new Error("late subscription disposal failed")])(
    "releases a subscription returned after observation disposal has already started (%s)",
    async (failure) => {
      const base = manualOwner(manualLifetime(() => undefined));
      let cleanup!: AsyncDisposable;
      let disposal!: PromiseLike<void>;
      const owner: ObservationOwner = {
        ...base,
        defer(dispose) {
          cleanup = base.defer(dispose);
          return cleanup;
        },
      };
      const release = vi.fn<() => void>(() => {
        if (failure) throw failure;
      });
      const observer = vi.fn<() => void>();
      const source: Readable<number> = {
        get: () => 1,
        subscribe() {
          disposal = cleanup[Symbol.asyncDispose]();
          return disposable(release);
        },
      };
      expect(() => observe(owner, source, observer)).toThrow("Observation is not active");
      const result = await Promise.resolve(disposal).catch((error: unknown) => error);
      expect(result).toBe(failure);
      expect(release).toHaveBeenCalledOnce();
      expect(observer).not.toHaveBeenCalled();
    },
  );

  it("does not establish a replacement after cancellation during the previous cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({ onError: report });
    const change = host.change();
    const source = signal(1);
    const seen: number[] = [];
    change.install(
      definePlugin({
        name: "observe.cancelled-replacement",
        setup(ctx) {
          observe(ctx.lifetime, source, (value, child) => {
            seen.push(value);
            child.defer(async () => {
              entered.resolve();
              await resume.promise;
            });
          });
        },
      }),
      { id: "observe.cancelled-replacement" },
    );
    await host.apply(await host.plan(change));
    await host.start();
    source.set(2);
    await entered.promise;
    const stopped = host.stop();
    await tick();
    resume.resolve();
    await stopped;
    expect(seen).toEqual([1]);
    expect(report).not.toHaveBeenCalled();
  });

  it("reads the initial value after ownership and subscription have been established", async () => {
    const host = createHost();
    const change = host.change();
    const source = signal(0);
    const seen: number[] = [];
    let begin!: () => AsyncDisposable;
    const installation = change.install(
      definePlugin({
        name: "observe.initial-boundary",
        setup(ctx) {
          begin = () => observe(ctx.lifetime, source, (value) => seen.push(value));
        },
      }),
      { id: "observe.initial-boundary" },
    );
    await host.apply(await host.plan(change));
    await host.start();
    const subscription = host.diagnostics.subscribe(() => {
      const lifetime = host.diagnostics
        .get()
        .installations.find((item) => item.id === installation.id)?.lifetime;
      if (lifetime?.children.length) source.set(1);
    });
    try {
      const observation = begin();
      await tick();
      expect(seen).toEqual([1]);
      await observation[Symbol.asyncDispose]();
    } finally {
      subscription[Symbol.dispose]();
      await host.stop();
    }
  });

  it("validates its public protocols before creating work", async () => {
    const unusedOwner = {} as ObservationOwner;
    expect(() => observe(unusedOwner, undefined as never, () => {})).toThrow(
      "observe() expects a readable source",
    );

    const source: Readable<number> = {
      get: () => 1,
      subscribe: () => disposable(() => undefined),
    };
    expect(() => observe(unusedOwner, source, undefined as never)).toThrow(
      "Observer must be a function",
    );
    expect(() => observe(unusedOwner, source, () => {})).toThrow(
      "observe() expects an observation owner",
    );
    expect(() =>
      observe(
        {
          defer: () => ({}) as unknown as AsyncDisposable,
          child: (_label) => manualLifetime(() => undefined),
          spawn: () => {
            throw new Error("Unexpected background task");
          },
        },
        source,
        () => {},
      ),
    ).toThrow("ObservationOwner.defer() must return an AsyncDisposable");
    expect(() =>
      observe(
        {
          defer: (dispose) =>
            asyncDisposable(async () => {
              await dispose();
            }),
          child: (_label) => ({ dispose() {} }) as unknown as AsyncDisposable,
          spawn: () => {
            throw new Error("Unexpected background task");
          },
        },
        source,
        () => {},
      ),
    ).toThrow("ObservationOwner.child() must return an AsyncDisposable");

    const owner = manualOwner(
      manualLifetime(() => {
        throw new Error("rollback failed");
      }),
    );
    expect(() =>
      observe(owner, { get: () => 1, subscribe: () => ({}) as Disposable }, () => {}),
    ).toThrow("Readable.subscribe() must return a Disposable");
    const malformedResult: Record<string, unknown> = {};
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercise the runtime protocol guard.
    malformedResult["then"] = true;
    const malformedTaskOwner = {
      defer: (dispose: () => void | PromiseLike<void>) =>
        asyncDisposable(async () => {
          await dispose();
        }),
      child: (_label: string) => manualLifetime(() => undefined),
      spawn: () => ({ dispose() {}, result: malformedResult }),
    } as unknown as ObservationOwner;
    expect(() => observe(malformedTaskOwner, source, () => {})).toThrow(
      "ObservationOwner.spawn() must return an ObservationTask",
    );
    await tick();
  });

  it("aggregates failures from the source and current lifetime during disposal", async () => {
    const subscriptionFailure = new Error("subscription cleanup failed");
    const lifetimeFailure = new Error("lifetime cleanup failed");
    const owner = manualOwner(
      manualLifetime(() => {
        throw lifetimeFailure;
      }),
    );
    const source: Readable<number> = {
      get: () => 1,
      subscribe: () =>
        disposable(() => {
          throw subscriptionFailure;
        }),
    };

    const observation = observe(owner, source, () => {});
    const failure = await Promise.resolve(observation[Symbol.asyncDispose]()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([subscriptionFailure, lifetimeFailure]);
  });

  it("creates owned child lifetimes under one semantic label", async () => {
    const labels: string[] = [];
    const source = new ControlledReadable(1);
    const observation = observe(
      manualOwner(
        manualLifetime(() => undefined),
        (label) => labels.push(label),
      ),
      source,
      () => undefined,
    );

    expect(labels).toEqual(["observation"]);
    await observation[Symbol.asyncDispose]();
  });

  it("rejects callable thenables and releases the initial subscription", async () => {
    const source = new ControlledReadable(1);
    const thenable = new Proxy(() => undefined, {
      has(target, property) {
        return property === "then" || Reflect.has(target, property);
      },
      get(target, property, receiver) {
        if (property === "then") {
          return (_resolve: (value: void) => void, reject: (error: unknown) => void) => {
            reject(new Error("thenable rejected"));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const plugin = definePlugin({
      name: "observe.callable-thenable",
      setup(ctx) {
        observe(ctx.lifetime, source, (() => thenable) as () => void);
      },
    });
    const host = createHost();
    const change = host.change();
    change.install(plugin, { id: plugin.name });

    await host.apply(await host.plan(change));
    const failure = await host.start().catch((error: unknown) => error);
    expect(errorTree(failure)).toContainEqual(
      new TypeError("Observers must be synchronous; use owner.spawn() for async work"),
    );
    expect(source.subscriptionsDisposed).toBe(1);
  });

  it("leaves initial cleanup failure visible to owner rollback", async () => {
    const source = new ControlledReadable(1);
    const observerFailure = new Error("observer failed");
    const cleanupFailure = new Error("observation cleanup failed");
    const plugin = definePlugin({
      name: "observe.initial-cleanup-failure",
      setup(ctx) {
        observe(ctx.lifetime, source, (_value, lifetime) => {
          lifetime.defer(() => {
            throw cleanupFailure;
          });
          throw observerFailure;
        });
      },
    });
    const host = createHost();
    const change = host.change();
    change.install(plugin, { id: plugin.name });

    await host.apply(await host.plan(change));
    const failure = await host.start().catch((error: unknown) => error);

    expect(errorTree(failure)).toEqual(expect.arrayContaining([observerFailure, cleanupFailure]));
  });

  it("fails initial subscription without running the observer", async () => {
    const source = new ControlledReadable(1);
    source.subscribeError = new Error("subscribe failed");
    const callback = vi.fn<() => void>();
    const plugin = definePlugin({
      name: "observe.subscribe-failure",
      setup(ctx) {
        observe(ctx.lifetime, source, callback);
      },
    });
    const host = createHost();
    const change = host.change();
    change.install(plugin, { id: plugin.name });

    await host.apply(await host.plan(change));
    const failure = await host.start().catch((error: unknown) => error);
    expect(errorTree(failure)).toContain(source.subscribeError);
    expect(callback).not.toHaveBeenCalled();
  });

  it("stops and releases current resources after a read failure", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    const plugin = definePlugin({
      name: "observe.read-retry",
      setup(ctx) {
        observe(ctx.lifetime, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.defer(() => trace.push(`stop:${value}`));
        });
      },
    });
    const host = createHost({ logger: log });
    const change = host.change();
    change.install(plugin, { id: plugin.name });
    await host.apply(await host.plan(change));
    await host.start();

    source.value = 2;
    source.getError = new Error("read failed");
    source.notify();
    await tick();
    await tick();
    expect(trace).toEqual(["start:1", "stop:1"]);
    expect(source.subscriptionsDisposed).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ message: "read failed" }));

    source.notify();
    await tick();
    expect(trace).toEqual(["start:1", "stop:1"]);
    await host.stop();
  });

  it("detaches its owner cleanup after stopping", async () => {
    const source = new ControlledReadable(1);
    const ownedCleanups = new Set<AsyncDisposable>();
    const base = manualOwner(manualLifetime(() => undefined));
    const owner: ObservationOwner = {
      ...base,
      defer(dispose) {
        let active = true;
        let handle!: AsyncDisposable;
        handle = asyncDisposable(async () => {
          if (!active) return;
          active = false;
          try {
            await dispose();
          } finally {
            ownedCleanups.delete(handle);
          }
        });
        ownedCleanups.add(handle);
        return handle;
      },
    };
    const handle = observe(owner, source, () => undefined);
    expect(ownedCleanups.size).toBe(1);

    source.getError = new Error("read failed");
    source.notify();
    await tick();
    await tick();

    expect(ownedCleanups.size).toBe(0);
    await handle[Symbol.asyncDispose]();
  });

  it("surfaces a synchronous failure while creating the owned drain task", async () => {
    const source = new ControlledReadable(1);
    let childDisposed = false;
    const owner = {
      ...manualOwner(
        manualLifetime(() => {
          childDisposed = true;
        }),
      ),
      spawn: () => {
        throw new Error("owner spawn failed");
      },
    } satisfies ObservationOwner;

    expect(() => observe(owner, source, () => {})).toThrow("owner spawn failed");
    expect(source.subscriptionsDisposed).toBe(1);
    await tick();
    expect(childDisposed).toBe(true);
  });

  it("coalesces invalidations behind one live replacement task", async () => {
    const source = new ControlledReadable(0);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let childIndex = 0;
    let spawnCount = 0;
    const values: number[] = [];
    const owner: ObservationOwner = {
      defer(dispose) {
        let active = true;
        return asyncDisposable(async () => {
          if (!active) return;
          active = false;
          await dispose();
        });
      },
      child(_label: string) {
        const index = childIndex++;
        return manualLifetime(() => (index === 0 ? barrier : undefined));
      },
      spawn(task) {
        spawnCount++;
        const controller = new AbortController();
        const result = Promise.resolve().then(() => task(controller.signal));
        const dispose = () => {
          controller.abort();
          return result.then(
            () => undefined,
            () => undefined,
          );
        };
        return {
          result,
          ...asyncDisposable(dispose),
        };
      },
    };
    const observation = observe(owner, source, (value) => values.push(value));

    source.value = 1;
    source.notify();
    await Promise.resolve();
    await Promise.resolve();
    for (let value = 2; value <= 20; value++) {
      source.value = value;
      source.notify();
      await Promise.resolve();
    }

    expect(spawnCount).toBe(1);
    release();
    await tick();
    expect(values).toEqual([0, 20]);
    await observation[Symbol.asyncDispose]();
  });

  it("stops permanently when the previous resources cannot be released", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    const plugin = definePlugin({
      name: "observe.cleanup-failure",
      setup(ctx) {
        observe(ctx.lifetime, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.defer(() => {
            trace.push(`stop:${value}`);
            throw new Error(`defer:${value}`);
          });
        });
      },
    });
    const host = createHost({ logger: log });
    const change = host.change();
    change.install(plugin, { id: plugin.name });
    await host.apply(await host.plan(change));
    await host.start();

    source.value = 2;
    source.notify();
    await tick();
    await tick();
    source.value = 3;
    source.notify();
    await tick();

    expect(trace).toEqual(["start:1", "stop:1"]);
    expect(source.subscriptionsDisposed).toBe(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(errorTree(log.error.mock.calls[0]?.[0])).toContainEqual(new Error("defer:1"));
    await expect(host.stop()).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
      details: { outcome: "quarantined" },
    });
    expect(host.status).toBe("quarantined");
  });

  it("cleans a failed replacement and stops the observation", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    let fail = true;
    const plugin = definePlugin({
      name: "observe.callback-retry",
      setup(ctx) {
        observe(ctx.lifetime, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.defer(() => trace.push(`stop:${value}`));
          if (value === 2 && fail) {
            fail = false;
            throw new Error("observer failed");
          }
        });
      },
    });
    const host = createHost({ logger: log });
    const change = host.change();
    change.install(plugin, { id: plugin.name });
    await host.apply(await host.plan(change));
    await host.start();

    source.value = 2;
    source.notify();
    await tick();
    await tick();
    expect(trace).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
    expect(source.subscriptionsDisposed).toBe(1);

    source.notify();
    await tick();
    expect(trace).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
    await host.stop();
  });

  it("releases source, observer and value after an observation stops", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createStoppedObservationRetentionFixture();
    try {
      for (
        let pass = 0;
        pass < 8 && [...fixture.references.values()].some((reference) => reference.deref());
        pass++
      ) {
        await tick();
        forceGc();
        forceGc();
      }

      for (const [name, reference] of fixture.references) {
        expect.soft(reference.deref(), `stopped observation retained ${name}`).toBeUndefined();
      }
    } finally {
      await fixture.host.stop();
    }
  });

  it("stops when a failed replacement cannot clean its partial resources", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    const observerFailure = new Error("observer failed");
    const cleanupFailure = new Error("partial cleanup failed");
    const plugin = definePlugin({
      name: "observe.failed-replacement-cleanup",
      setup(ctx) {
        observe(ctx.lifetime, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.defer(() => {
            trace.push(`stop:${value}`);
            if (value === 2) throw cleanupFailure;
          });
          if (value === 2) throw observerFailure;
        });
      },
    });
    const host = createHost({ logger: log });
    const change = host.change();
    change.install(plugin, { id: plugin.name });
    await host.apply(await host.plan(change));
    await host.start();

    source.value = 2;
    source.notify();
    await tick();
    await tick();

    expect(trace).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
    expect(source.subscriptionsDisposed).toBe(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(errorTree(log.error.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([observerFailure, cleanupFailure]),
    );
    await expect(host.stop()).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
      details: { outcome: "quarantined" },
    });
    expect(host.status).toBe("quarantined");
  });
});

async function createStoppedObservationRetentionFixture() {
  let value: object | undefined = {};
  let source: ControlledReadable<object | undefined> | undefined = new ControlledReadable(value);
  let observer: ((value: object | undefined) => void) | undefined = () => undefined;
  const references = new Map<string, WeakRef<object>>([
    ["source", new WeakRef(source)],
    ["observer", new WeakRef(observer)],
    ["value", new WeakRef(value)],
  ]);
  const declaration: {
    source: ControlledReadable<object | undefined> | undefined;
    observer: ((value: object | undefined) => void) | undefined;
  } = { source, observer };
  const host = createHost({ logger: logger() });
  const change = host.change();
  change.install(
    definePlugin({
      name: "observe.stopped-retention",
      setup(ctx) {
        const currentSource = declaration.source;
        const currentObserver = declaration.observer;
        if (!currentSource || !currentObserver) throw new Error("Observation fixture was released");
        observe(ctx.lifetime, currentSource, currentObserver);
      },
    }),
    { id: "observe.stopped-retention" },
  );
  await host.apply(await host.plan(change));
  await host.start();

  source.getError = new Error("stop observation");
  source.notify();
  await tick();
  await tick();
  expect(source.subscriptionsDisposed).toBe(1);

  source.value = undefined;
  declaration.source = undefined;
  declaration.observer = undefined;
  source = undefined;
  observer = undefined;
  value = undefined;
  return { host, references };
}

it("observes only the latest value after asynchronous cleanup completes", async () => {
  const source = new ControlledReadable("A");
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  const host = createHost();
  const change = host.change();
  change.install(
    definePlugin({
      name: "observe.latest",
      setup(ctx) {
        observe(ctx.lifetime, source, (value, child) => {
          seen.push(value);
          child.defer(async () => {
            if (value === "A") {
              cleaning.resolve();
              await release.promise;
            }
          });
        });
      },
    }),
    { id: "observe.latest" },
  );
  await host.apply(await host.plan(change));
  await host.start();
  source.value = "B";
  source.notify();
  await cleaning.promise;
  source.value = "C";
  source.notify();
  release.resolve();
  await tick();
  expect(seen).toEqual(["A", "C"]);
  await host.stop();
});

it("keeps failed unsubscription owned after a source read stops the drain", async () => {
  let notify!: () => void;
  let broken = false;
  const releaseError = new Error("subscription still active");
  const release = vi.fn<() => never>(() => {
    throw releaseError;
  });
  const reported = Promise.withResolvers<unknown>();
  const source: Readable<number> = {
    get() {
      if (broken) throw new Error("read failed");
      return 1;
    },
    subscribe(listener) {
      notify = listener;
      return disposable(release);
    },
  };
  const host = createHost({
    onError: reported.resolve,
    installations: [
      {
        id: "observer",
        plugin: definePlugin({
          name: "observer",
          setup({ lifetime }) {
            observe(lifetime, source, () => undefined);
          },
        }),
      },
    ],
  });
  await host.start();
  broken = true;
  notify();
  expect(errorTree(await reported.promise)).toContain(releaseError);
  const failure = await host.stop().catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "HOST_QUARANTINED" });
  expect(errorTree(failure)).toContain(releaseError);
  expect(release).toHaveBeenCalledOnce();
});

it("binds a single Readable subscription and read protocol to its release", async () => {
  const owner = manualOwner(manualLifetime(() => undefined));
  const seen: number[] = [];
  let notify!: () => void;
  let value = 1;
  let reads = 0;
  let subscribes = 0;
  let disposers = 0;
  const released = vi.fn<() => void>();
  const readable: Readable<number> = {
    get get() {
      if (++reads !== 1) throw new Error("read protocol changed");
      return () => value;
    },
    get subscribe() {
      if (++subscribes !== 1) throw new Error("subscribe protocol changed");
      return (listener: () => void) => {
        notify = listener;
        return {
          get [Symbol.dispose]() {
            if (++disposers !== 1) throw new Error("release protocol changed");
            return released;
          },
        };
      };
    },
  };
  const observation = observe(owner, readable, (next) => seen.push(next));
  value = 2;
  notify();
  await tick();
  await observation[Symbol.asyncDispose]();
  expect(seen).toEqual([1, 2]);
  expect(released).toHaveBeenCalledOnce();
});

it.each(["bridge", "observe"] as const)(
  "releases the owner registration after clean %s construction failure",
  async (adapter) => {
    let attach!: () => void;
    const failed = new Error("post-attachment read failed");
    let subscribed = false;
    const source: Readable<number> = {
      get() {
        if (subscribed) throw failed;
        return 0;
      },
      subscribe() {
        subscribed = true;
        return disposable(() => {
          subscribed = false;
        });
      },
    };
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            setup({ lifetime }) {
              attach = () => {
                if (adapter === "bridge") bridge(lifetime, source);
                else observe(lifetime, source, () => undefined);
              };
            },
          }),
        },
      ],
    });
    await host.start();
    const before = host.diagnostics.get().installations[0]!.lifetime!;
    expect(attach).toThrow(failed);
    await tick();
    expect(subscribed).toBe(false);
    expect(host.diagnostics.get().installations[0]?.lifetime).toEqual(before);
    await host.stop();
  },
);

it("joins an ongoing failed child release when the caller closes during replacement", async () => {
  const failure = new Error("child release failed");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const release = vi.fn<() => Promise<void>>(async () => {
    entered.resolve();
    await resume.promise;
    throw failure;
  });
  const source = new ControlledReadable(1);
  const observer = vi.fn<(value: number) => void>();
  const handle = observe(manualOwner(manualLifetime(release)), source, observer);
  source.value = 2;
  source.notify();
  await entered.promise;
  const closing = handle[Symbol.asyncDispose]();
  resume.resolve();
  await expect(closing).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(source.subscriptionsDisposed).toBe(1);
  expect(observer.mock.calls).toEqual([[1, expect.anything()]]);
});

it("still releases the child after its drain task fails to close", async () => {
  const failure = new Error("drain teardown failed");
  const released = vi.fn<() => void>();
  const base = manualOwner(manualLifetime(released));
  const owner: ObservationOwner = {
    ...base,
    spawn(task) {
      const runner = base.spawn(task);
      return {
        result: runner.result,
        async [Symbol.asyncDispose]() {
          await runner[Symbol.asyncDispose]();
          throw failure;
        },
      };
    },
  };
  const source = new ControlledReadable(1);
  const handle = observe(owner, source, () => undefined);
  await expect(handle[Symbol.asyncDispose]()).rejects.toBe(failure);
  expect(source.subscriptionsDisposed).toBe(1);
  expect(released).toHaveBeenCalledOnce();
});

it("reports both registration and synchronous rollback failures on observation construction", () => {
  const sourceFailure = new Error("subscribe failed");
  const cleanupFailure = new Error("owner release failed");
  const source = new ControlledReadable(1);
  source.subscribeError = sourceFailure;
  const owner: ObservationOwner = {
    ...manualOwner(manualLifetime(() => undefined)),
    defer: () => ({
      [Symbol.asyncDispose]() {
        throw cleanupFailure;
      },
    }),
  };
  expect(() => observe(owner, source, () => undefined)).toThrow(
    expect.objectContaining({ errors: [sourceFailure, cleanupFailure] }),
  );
});

it("runs an observer without handing its caller the internal mutation binding", async () => {
  const owner = manualOwner(manualLifetime(() => undefined));
  let receiver: unknown = null;
  const stop = observe(owner, signal(0), function (this: unknown) {
    receiver = this;
  });
  try {
    expect(receiver).toBeUndefined();
  } finally {
    await stop[Symbol.asyncDispose]();
  }
});

it.each(["invalid", "throwing"] as const)(
  "releases a returned drain Task even if its result is %s",
  async (kind) => {
    const fail = new Error("result getter failed");
    const releases: string[] = [];
    const source = new ControlledReadable(0);
    const owner: ObservationOwner = {
      ...manualOwner(
        manualLifetime(() => {
          releases.push("child");
        }),
      ),
      spawn<T>() {
        return {
          get result(): Promise<T> {
            if (kind === "throwing") throw fail;
            return null as unknown as Promise<T>;
          },
          async [Symbol.asyncDispose]() {
            releases.push("runner");
          },
        };
      },
    };
    expect(() => observe(owner, source, () => undefined)).toThrow(
      kind === "throwing" ? fail : "must return an ObservationTask",
    );
    await tick();
    expect(source.subscriptionsDisposed).toBe(1);
    expect(releases).toEqual(["runner", "child"]);
  },
);

it("uses the accepted release methods for the observation registration, drain and child", async () => {
  const released: string[] = [];
  const child = manualLifetime(() => {
    released.push("child");
  });
  const base = manualOwner(child);
  let registration!: AsyncDisposable, runner!: AsyncDisposable;
  const owner: ObservationOwner = {
    ...base,
    defer(dispose) {
      registration = {
        async [Symbol.asyncDispose]() {
          released.push("registration");
          await dispose();
        },
      };
      return registration;
    },
    spawn<T>(task: (signal: AbortSignal) => T | PromiseLike<T>) {
      const actual = base.spawn(task);
      const handle = {
        result: actual.result,
        async [Symbol.asyncDispose]() {
          released.push("runner");
          await actual[Symbol.asyncDispose]();
        },
      };
      runner = handle;
      return handle;
    },
  };
  const observation = observe(owner, signal(1), () => undefined);
  for (const handle of [child, runner, registration]) {
    Object.defineProperty(handle, Symbol.asyncDispose, {
      value() {
        throw new Error("replacement must not run");
      },
    });
  }
  await observation[Symbol.asyncDispose]();
  expect(released).toEqual(["registration", "runner", "child"]);
});

it.each(["bridge", "observe"] as const)(
  "invokes the captured %s methods even when the callable shadows bind or call",
  async (adapter) => {
    const base = manualOwner(manualLifetime(() => undefined));
    const source = new ControlledReadable(5);
    function decorated<F extends (...args: never[]) => unknown>(fn: F): F {
      return Object.assign(fn, { bind: null, call: null });
    }
    const owner: ObservationOwner = {
      child: decorated((label) => base.child(label)),
      spawn: decorated(base.spawn),
      defer: decorated((release) => {
        const cleanup = base.defer(release);
        return { [Symbol.asyncDispose]: decorated(() => cleanup[Symbol.asyncDispose]()) };
      }),
    };
    const readable = {
      get: decorated(source.get.bind(source)),
      subscribe: decorated(source.subscribe.bind(source)),
    };
    const seen: number[] = [];
    if (adapter === "observe") {
      const handle = observe(owner, readable, (value) => seen.push(value));
      await handle[Symbol.asyncDispose]();
    } else {
      const local = bridge(owner, readable);
      seen.push(local.get());
    }
    expect(seen).toEqual([5]);
  },
);

it.each([false, true])(
  "obeys the task controller when owner signal properties contradict native state (already aborted: %s)",
  async (alreadyAborted) => {
    const controller = new AbortController();
    const parent = controller.signal;
    parent.addEventListener("abort", (event) => event.stopImmediatePropagation());
    if (alreadyAborted) controller.abort("finished before attachment");
    const foreignMethod = vi.fn<() => never>(() => {
      throw new Error("signal method overridden by supplier");
    });
    Object.defineProperties(parent, {
      aborted: { value: !alreadyAborted },
      reason: { value: "forged reason" },
      addEventListener: { value: foreignMethod },
      removeEventListener: { value: foreignMethod },
    });
    let finished = false;
    const owner: ObservationOwner = {
      ...manualOwner(manualLifetime(() => undefined)),
      spawn(task) {
        const result = Promise.resolve(task(parent)).finally(() => {
          finished = true;
        });
        return {
          result,
          async [Symbol.asyncDispose]() {
            await result;
          },
        };
      },
    };
    const source = new ControlledReadable(1);
    const seen: number[] = [];
    const observation = observe(owner, source, (value) => seen.push(value));
    try {
      parent.dispatchEvent(new Event("abort"));
      source.value = 2;
      source.notify();
      await tick();
      expect(finished).toBe(alreadyAborted);
      expect(seen).toEqual(alreadyAborted ? [1] : [1, 2]);
      controller.abort("real shutdown");
      await tick();
      expect(finished).toBe(true);
    } finally {
      await observation[Symbol.asyncDispose]();
    }
    expect(source.subscriptionsDisposed).toBe(1);
    expect(foreignMethod).not.toHaveBeenCalled();
  },
);
