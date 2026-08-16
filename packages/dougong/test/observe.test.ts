import { describe, expect, it, vi } from "vitest";
import type { Disposable } from "@dougongjs/core";
import {
  createHost,
  definePlugin,
  observe,
  type Logger,
  type ObservationLifetime,
  type ObservationOwner,
  type Readable,
} from "../src/index";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.subscriptionsDisposed++;
        this.#listeners.delete(listener);
      },
    };
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

function manualOwner(
  child: ObservationLifetime,
  onLifetime: (label: string) => void = () => undefined,
): ObservationOwner {
  return {
    cleanup(dispose) {
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          return dispose() as void | Promise<void>;
        },
      };
    },
    lifetime: (label) => {
      onLifetime(label);
      return child;
    },
    spawn: (task) => {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => task(controller.signal));
      return {
        result,
        dispose() {
          controller.abort();
          return result.then(
            () => undefined,
            () => undefined,
          );
        },
      };
    },
  };
}

function manualLifetime(dispose: () => void | Promise<void>): ObservationLifetime {
  const lifetime: ObservationLifetime = {
    dispose,
    cleanup: () => {
      throw new Error("Unexpected cleanup registration");
    },
    lifetime: (_label) => lifetime,
    spawn: () => {
      throw new Error("Unexpected background task");
    },
  };
  return lifetime;
}

describe("observe composition", () => {
  it("validates its public protocols before creating work", async () => {
    const unusedOwner = {} as ObservationOwner;
    expect(() => observe(unusedOwner, undefined as never, () => {})).toThrow(
      "observe() expects a readable source",
    );

    const source: Readable<number> = {
      get: () => 1,
      subscribe: () => ({ dispose() {} }),
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
          cleanup: () => ({}) as Disposable,
          lifetime: (_label) => manualLifetime(() => undefined),
          spawn: () => {
            throw new Error("Unexpected background task");
          },
        },
        source,
        () => {},
      ),
    ).toThrow("ObservationOwner.cleanup() must return a Disposable");
    expect(() =>
      observe(
        {
          cleanup: (dispose) => ({
            dispose: () => dispose() as void | Promise<void>,
          }),
          lifetime: (_label) => ({ dispose() {} }) as ObservationLifetime,
          spawn: () => {
            throw new Error("Unexpected background task");
          },
        },
        source,
        () => {},
      ),
    ).toThrow("ObservationOwner.lifetime() must return an ObservationLifetime");

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
      cleanup: (dispose: () => void | Promise<void>) => ({ dispose }),
      lifetime: (_label: string) => manualLifetime(() => undefined),
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
      subscribe: () => ({
        dispose() {
          throw subscriptionFailure;
        },
      }),
    };

    const observation = observe(owner, source, () => {});
    const failure = await Promise.resolve(observation.dispose()).catch((error: unknown) => error);

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
    await observation.dispose();
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
        observe(ctx, source, (() => thenable) as () => void);
      },
    });
    const host = createHost();
    host.install(plugin);

    await expect(host.start()).rejects.toThrow(
      "Observers must be synchronous; use lifetime.spawn() for async work",
    );
    expect(source.subscriptionsDisposed).toBe(1);
  });

  it("fails initial subscription without running the observer", async () => {
    const source = new ControlledReadable(1);
    source.subscribeError = new Error("subscribe failed");
    const callback = vi.fn<() => void>();
    const plugin = definePlugin({
      name: "observe.subscribe-failure",
      setup(ctx) {
        observe(ctx, source, callback);
      },
    });
    const host = createHost();
    host.install(plugin);

    await expect(host.start()).rejects.toThrow("subscribe failed");
    expect(callback).not.toHaveBeenCalled();
  });

  it("stops and releases current resources after a read failure", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    const plugin = definePlugin({
      name: "observe.read-retry",
      setup(ctx) {
        observe(ctx, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.cleanup(() => trace.push(`stop:${value}`));
        });
      },
    });
    const host = createHost({ logger: log });
    host.install(plugin);
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

  it("surfaces a synchronous failure while creating the owned drain task", async () => {
    const source = new ControlledReadable(1);
    let childDisposed = false;
    const owner = manualOwner(
      manualLifetime(() => {
        childDisposed = true;
      }),
    );
    owner.spawn = () => {
      throw new Error("owner spawn failed");
    };

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
      cleanup(dispose) {
        let active = true;
        return {
          dispose() {
            if (!active) return;
            active = false;
            return dispose() as void | Promise<void>;
          },
        };
      },
      lifetime(_label: string) {
        const index = childIndex++;
        return manualLifetime(() => (index === 0 ? barrier : undefined));
      },
      spawn(task) {
        spawnCount++;
        const controller = new AbortController();
        const result = Promise.resolve().then(() => task(controller.signal));
        return {
          result,
          dispose() {
            controller.abort();
            return result.then(
              () => undefined,
              () => undefined,
            );
          },
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
    expect(values).toEqual([0, 1, 20]);
    await observation.dispose();
  });

  it("stops permanently when the previous resources cannot be released", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    const plugin = definePlugin({
      name: "observe.cleanup-failure",
      setup(ctx) {
        observe(ctx, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.cleanup(() => {
            trace.push(`stop:${value}`);
            throw new Error(`cleanup:${value}`);
          });
        });
      },
    });
    const host = createHost({ logger: log });
    host.install(plugin);
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
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ message: "cleanup:1" }));
    await host.stop();
  });

  it("cleans a failed replacement and stops the observation", async () => {
    const source = new ControlledReadable(1);
    const trace: string[] = [];
    const log = logger();
    let fail = true;
    const plugin = definePlugin({
      name: "observe.callback-retry",
      setup(ctx) {
        observe(ctx, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.cleanup(() => trace.push(`stop:${value}`));
          if (value === 2 && fail) {
            fail = false;
            throw new Error("observer failed");
          }
        });
      },
    });
    const host = createHost({ logger: log });
    host.install(plugin);
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
    const plugin = definePlugin({
      name: "observe.failed-replacement-cleanup",
      setup(ctx) {
        observe(ctx, source, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.cleanup(() => {
            trace.push(`stop:${value}`);
            if (value === 2) throw new Error("partial cleanup failed");
          });
          if (value === 2) throw new Error("observer failed");
        });
      },
    });
    const host = createHost({ logger: log });
    host.install(plugin);
    await host.start();

    source.value = 2;
    source.notify();
    await tick();
    await tick();

    expect(trace).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
    expect(source.subscriptionsDisposed).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Observation callback failed and its resources could not be cleaned up",
      }),
    );
    await host.stop();
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
  host.install(
    definePlugin({
      name: "observe.stopped-retention",
      setup(ctx) {
        const currentSource = declaration.source;
        const currentObserver = declaration.observer;
        if (!currentSource || !currentObserver) throw new Error("Observation fixture was released");
        observe(ctx, currentSource, currentObserver);
      },
    }),
  );
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
