import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  type HostOptions,
  type ChildLifetime,
  type LifetimeContext,
  type Logger,
} from "dougong";
import { observe, signal } from "@dougongjs/reactive";
import { SerialQueue } from "dougong/advanced";
import { acquireForLifetime } from "../src/retired-acquisition";

async function createFixture(options: HostOptions = {}) {
  const report = vi.fn<(error: unknown) => void>();
  let owner!: LifetimeContext;
  const plugin = definePlugin({
    name: "examples.retired-acquisition",
    setup(context) {
      owner = context.lifetime.child("application");
    },
  });
  const host = createHost({
    onError: report,
    ...options,
    installations: [{ id: "application", plugin }],
  });
  await host.start();
  return {
    host,
    owner,
    generation: owner.child("generation"),
    operations: owner.child("external-operations"),
    report,
  };
}

describe("resource acquisition with explicit waiter retirement", () => {
  it("never starts an operation for an already disposed generation", async () => {
    const { host, generation, operations, report } = await createFixture();
    const start = vi.fn<() => Promise<object>>(() => Promise.resolve({ id: "unused" }));
    const dispose = vi.fn<(value: object) => void>();
    try {
      await generation[Symbol.asyncDispose]();

      await expect(acquireForLifetime(generation, operations, start, dispose)).rejects.toBe(
        generation.signal.reason,
      );

      expect(start).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("rejects a disposed operations owner before creating a Task", async () => {
    const { host, generation, operations, report } = await createFixture();
    const start = vi.fn<() => Promise<object>>(() => Promise.resolve({ id: "unused" }));
    const dispose = vi.fn<(value: object) => void>();
    try {
      await operations[Symbol.asyncDispose]();

      await expect(
        acquireForLifetime(generation, operations, start, dispose),
      ).rejects.toMatchObject({
        code: "LIFETIME_DISPOSED",
      });

      expect(generation.signal.aborted).toBe(false);
      expect(getEventListeners(generation.signal, "abort")).toHaveLength(0);
      expect(start).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("does not start queued work once its operations Lifetime aborts", async () => {
    const { host, generation, operations, report } = await createFixture();
    const start = vi.fn<() => Promise<object>>(() => Promise.resolve({ id: "unused" }));
    const dispose = vi.fn<(value: object) => void>();
    let retirement: Promise<void> | undefined;
    try {
      const result = acquireForLifetime(generation, operations, start, dispose);
      queueMicrotask(() => {
        retirement = operations[Symbol.asyncDispose]();
      });

      await expect(result).resolves.toEqual({ status: "retired" });
      await retirement;

      expect(generation.signal.aborted).toBe(false);
      expect(getEventListeners(generation.signal, "abort")).toHaveLength(0);
      expect(start).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("does not start queued work after its waiting generation retires", async () => {
    const { host, generation, operations, report } = await createFixture();
    const start = vi.fn<() => Promise<object>>(() => Promise.resolve({ id: "unused" }));
    const dispose = vi.fn<(value: object) => void>();
    let retirement: Promise<void> | undefined;
    try {
      const result = acquireForLifetime(generation, operations, start, dispose);
      const observed = result.catch((error: unknown) => error);
      queueMicrotask(() => {
        retirement = generation[Symbol.asyncDispose]();
      });

      expect(await observed).toBe(generation.signal.reason);
      await retirement;
      await operations[Symbol.asyncDispose]();

      expect(start).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it.each(["abort first", "resolve first"])(
    "releases a late resource once with adjacent microtasks: %s",
    async (order) => {
      const { host, generation, operations, report } = await createFixture();
      const started = Promise.withResolvers<void>();
      const operation = Promise.withResolvers<object>();
      const resource = { id: "old" };
      const dispose = vi.fn<(value: object) => void>();
      const delivered = vi.fn<(value: object) => void>();
      const start = vi.fn<() => Promise<object>>(() => {
        started.resolve();
        return operation.promise;
      });
      const waiter = generation.spawn(async () => {
        const result = await acquireForLifetime(generation, operations, start, dispose);
        if (result.status === "acquired") delivered(result.value);
      });
      let retirement: Promise<void> | undefined;
      try {
        await started.promise;
        const abort = () => {
          retirement = generation[Symbol.asyncDispose]();
        };
        const resolve = () => operation.resolve(resource);
        for (const reaction of order === "abort first" ? [abort, resolve] : [resolve, abort]) {
          queueMicrotask(reaction);
        }
        await setImmediate();
        await retirement;
        await operations[Symbol.asyncDispose]();

        await expect(waiter.result).rejects.toBe(generation.signal.reason);
        expect(start).toHaveBeenCalledOnce();
        expect(delivered).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
        expect(report).not.toHaveBeenCalled();
      } finally {
        operation.resolve(resource);
        await host.stop();
      }
    },
  );

  it("reclaims late work if the operations owner retires while its destination stays open", async () => {
    const { host, generation, operations } = await createFixture();
    const started = Promise.withResolvers<void>();
    const factory = Promise.withResolvers<object>();
    const resource = {};
    const release = vi.fn<(resource: object) => void>();
    const result = acquireForLifetime(
      generation,
      operations,
      () => {
        started.resolve();
        return factory.promise;
      },
      release,
    );
    try {
      await started.promise;
      const draining = operations[Symbol.asyncDispose]();
      factory.resolve(resource);
      await expect(result).resolves.toEqual({ status: "retired" });
      await draining;
      expect(release).toHaveBeenCalledExactlyOnceWith(resource);
      expect(generation.signal.aborted).toBe(false);
    } finally {
      factory.resolve(resource);
      await host.stop();
    }
  });

  it("registers ownership before delivery and cleans a resource retired during that handoff", async () => {
    const { host, generation, operations, report } = await createFixture();
    const started = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<object>();
    const release = Promise.withResolvers<void>();
    const resource = { id: "transferred" };
    const dispose = vi.fn<(value: object) => Promise<void>>(() => release.promise);
    const delivered = vi.fn<(value: object) => void>();
    const waiter = generation.spawn(async () => {
      const result = await acquireForLifetime(
        generation,
        operations,
        () => {
          started.resolve();
          return operation.promise;
        },
        dispose,
      );
      if (result.status === "acquired") delivered(result.value);
    });
    let generationDisposed = false;
    let operationsDisposed = false;
    try {
      await started.promise;
      // Abort follows ownership transfer but precedes delivery to the waiting generation.
      operation.resolve(resource);
      queueMicrotask(() => {
        void generation[Symbol.asyncDispose]().then(() => {
          generationDisposed = true;
        });
      });
      await setImmediate();
      const draining = operations[Symbol.asyncDispose]().then(() => {
        operationsDisposed = true;
      });
      await setImmediate();

      await expect(waiter.result).rejects.toBe(generation.signal.reason);
      expect(delivered).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
      expect(operationsDisposed).toBe(true);
      expect(generationDisposed).toBe(false);
      await draining;
      release.resolve();
      await generation[Symbol.asyncDispose]();
      expect(report).not.toHaveBeenCalled();
    } finally {
      operation.resolve(resource);
      release.resolve();
      await host.stop();
    }
  });

  it("delivers an accepted resource once and releases it through the generation", async () => {
    const { host, generation, operations, report } = await createFixture();
    const resource = { id: "accepted" };
    const start = vi.fn<() => Promise<object>>(() => Promise.resolve(resource));
    const dispose = vi.fn<(value: object) => void>();
    try {
      const result = await acquireForLifetime(generation, operations, start, dispose);
      expect(result).toEqual({ status: "acquired", value: resource });
      expect(dispose).not.toHaveBeenCalled();

      await operations[Symbol.asyncDispose]();
      expect(dispose).not.toHaveBeenCalled();
      await Promise.all([generation[Symbol.asyncDispose](), generation[Symbol.asyncDispose]()]);

      expect(start).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("reclaims a value when start synchronously disposes its generation", async () => {
    const { host, generation, operations, report } = await createFixture();
    const resource = { id: "retired-inside-start" };
    const dispose = vi.fn<(value: object) => void>();
    let retirement: Promise<void> | undefined;
    const start = vi.fn<() => Promise<object>>(() => {
      retirement = generation[Symbol.asyncDispose]();
      return Promise.resolve(resource);
    });
    try {
      const waiter = generation.spawn(() =>
        acquireForLifetime(generation, operations, start, dispose),
      );
      await setImmediate();
      await expect(waiter.result).rejects.toBe(generation.signal.reason);
      await retirement;
      await operations[Symbol.asyncDispose]();

      expect(start).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
      expect(report).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("retires a pending generation while operations and Host shutdown still join late disposal", async () => {
    const { host, owner, generation, operations, report } = await createFixture();
    const started = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<object>();
    const release = Promise.withResolvers<void>();
    const oldResource = { id: "old" };
    const nextResource = { id: "next" };
    const dispose = vi.fn<(resource: object) => void | Promise<void>>((resource) =>
      resource === oldResource ? release.promise : undefined,
    );
    const start = vi.fn<() => Promise<object>>(() => {
      started.resolve();
      return operation.promise;
    });
    const waiter = generation.spawn(() =>
      acquireForLifetime(generation, operations, start, dispose),
    );
    let retired = false;
    let operationsDisposed = false;
    let hostStopped = false;
    try {
      await started.promise;
      const retirement = generation[Symbol.asyncDispose]().then(() => {
        retired = true;
      });
      await setImmediate();
      expect(retired).toBe(true);
      await retirement;
      await expect(waiter.result).rejects.toBe(generation.signal.reason);

      const next = owner.child("next-generation");
      let nextResult: unknown;
      next.spawn(async () => {
        nextResult = await acquireForLifetime(
          next,
          operations,
          () => Promise.resolve(nextResource),
          dispose,
        );
      });
      await setImmediate();
      expect(nextResult).toEqual({ status: "acquired", value: nextResource });
      expect(dispose).not.toHaveBeenCalled();

      const draining = operations[Symbol.asyncDispose]().then(() => {
        operationsDisposed = true;
      });
      const stopping = host.stop().then(() => {
        hostStopped = true;
      });
      await setImmediate();
      expect(operations.signal.aborted).toBe(true);
      expect(operationsDisposed).toBe(false);
      expect(hostStopped).toBe(false);

      operation.resolve(oldResource);
      await setImmediate();
      expect(dispose).toHaveBeenCalledWith(oldResource);
      expect(operationsDisposed).toBe(false);
      expect(hostStopped).toBe(false);
      release.resolve();
      await Promise.all([draining, stopping]);

      expect(dispose.mock.calls.filter(([value]) => value === oldResource)).toHaveLength(1);
      expect(start).toHaveBeenCalledOnce();
      expect(report).not.toHaveBeenCalled();
    } finally {
      operation.resolve(oldResource);
      release.resolve();
      await host.stop();
    }
  });

  it("lets observe replace its generation without delivering the previous operation's late value", async () => {
    const { host, owner, operations, report } = await createFixture();
    const source = signal("old");
    const operation = Promise.withResolvers<object>();
    const oldResource = { id: "old" };
    const nextResource = { id: "next" };
    const started: string[] = [];
    const delivered: object[] = [];
    const dispose = vi.fn<(value: object) => void>();
    const observation = observe(owner, source, (identity, generation) => {
      generation.spawn(async () => {
        const result = await acquireForLifetime(
          generation,
          operations,
          () => {
            started.push(identity);
            return identity === "old" ? operation.promise : Promise.resolve(nextResource);
          },
          dispose,
        );
        if (result.status === "acquired") delivered.push(result.value);
      });
    });
    try {
      await setImmediate();
      expect(started).toEqual(["old"]);
      source.set("next");
      await setImmediate();

      expect(started).toEqual(["old", "next"]);
      expect(delivered).toEqual([nextResource]);
      expect(dispose).not.toHaveBeenCalled();

      let observationDisposed = false;
      const stopping = observation[Symbol.asyncDispose]().then(() => {
        observationDisposed = true;
      });
      await setImmediate();
      expect(observationDisposed).toBe(true);
      await stopping;
      expect(dispose).toHaveBeenCalledExactlyOnceWith(nextResource);

      operation.resolve(oldResource);
      await operations[Symbol.asyncDispose]();
      expect(delivered).toEqual([nextResource]);
      expect(dispose.mock.calls).toEqual([[nextResource], [oldResource]]);
      expect(started).toEqual(["old", "next"]);
      expect(report).not.toHaveBeenCalled();
    } finally {
      operation.resolve(oldResource);
      await host.stop();
    }
  });
});

describe("acquisition failure ownership", () => {
  it.each(["synchronous", "asynchronous"])(
    "projects a %s start failure without reporting it twice",
    async (mode) => {
      const { host, generation, operations, report } = await createFixture();
      const failure = new Error("start failed");
      const dispose = vi.fn<(value: object) => void>();
      try {
        const waiter = generation.spawn(() =>
          acquireForLifetime(
            generation,
            operations,
            () => {
              if (mode === "synchronous") throw failure;
              return Promise.reject(failure);
            },
            dispose,
          ),
        );
        const result = await waiter.result;

        expect(result).toMatchObject({ status: "failed", error: { cause: failure } });
        if (result.status !== "failed") throw new Error("Expected a failed acquisition");
        await operations[Symbol.asyncDispose]();
        expect(report).toHaveBeenCalledExactlyOnceWith(result.error);
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        await host.stop();
      }
    },
  );

  it("keeps a failure reported once when retirement interrupts its delivery", async () => {
    let generation!: ChildLifetime;
    let retirement: Promise<void> | undefined;
    const report = vi.fn<(error: unknown) => void>(() => {
      retirement = generation[Symbol.asyncDispose]();
    });
    const fixture = await createFixture({ onError: report });
    generation = fixture.generation;
    const failure = new Error("failed before retirement");
    try {
      const waiter = generation.spawn(() =>
        acquireForLifetime(
          generation,
          fixture.operations,
          () => Promise.reject(failure),
          vi.fn<(value: object) => void>(),
        ),
      );
      await setImmediate();
      await expect(waiter.result).rejects.toBe(generation.signal.reason);
      await retirement;
      await fixture.operations[Symbol.asyncDispose]();

      expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: failure }));
    } finally {
      await fixture.host.stop();
    }
  });

  it.each([
    ["operation rejection", false],
    ["operation rejection", true],
    ["synchronous disposal", false],
    ["synchronous disposal", true],
    ["asynchronous disposal", false],
    ["asynchronous disposal", true],
  ] as const)("reports late %s during Host shutdown (AbortError: %s)", async (mode, abortError) => {
    const { host, generation, operations, report } = await createFixture();
    const started = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<object>();
    const resource = { id: "late" };
    const failure = abortError
      ? new DOMException("independent adapter failure", "AbortError")
      : new Error("adapter failed");
    const dispose = vi.fn<(value: object) => void | Promise<never>>(() => {
      if (mode === "synchronous disposal") throw failure;
      if (mode === "asynchronous disposal") return Promise.reject(failure);
      return undefined;
    });
    const waiter = generation.spawn(() =>
      acquireForLifetime(
        generation,
        operations,
        () => {
          started.resolve();
          return operation.promise;
        },
        dispose,
      ),
    );
    try {
      await started.promise;
      const stopping = host.stop();
      await setImmediate();
      expect(operations.signal.aborted).toBe(true);
      await expect(waiter.result).rejects.toBe(generation.signal.reason);

      if (mode === "operation rejection") operation.reject(failure);
      else operation.resolve(resource);
      const releaseFailed = mode !== "operation rejection";
      await expect(Promise.allSettled([stopping])).resolves.toMatchObject([
        releaseFailed
          ? { status: "rejected", reason: { code: "HOST_QUARANTINED" } }
          : { status: "fulfilled" },
      ]);
      const retained = host.diagnostics
        .get()
        .unresolved.flatMap((instance) =>
          instance.lifetime.children.flatMap((child) => child.children),
        );
      expect(retained).toMatchObject(
        releaseFailed
          ? [
              {
                label: "external-operations",
                unresolved: [{ kind: "cleanup" }],
              },
            ]
          : [],
      );
      await setImmediate();

      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: "Error", cause: failure }),
      );
      expect(dispose.mock.calls).toEqual(mode === "operation rejection" ? [] : [[resource]]);
    } finally {
      operation.resolve(resource);
      await Promise.allSettled([host.stop()]);
    }
  });

  it("uses Host fallback aggregation when its asynchronous error observer rejects", async () => {
    const failure = new Error("late operation failed");
    const reporterFailure = new Error("reporter failed");
    const terminalFailure = new Error("terminal logger failed");
    const reporter = vi.fn<(error: unknown) => Promise<never>>(() =>
      Promise.reject(reporterFailure),
    );
    const logger = {
      debug: vi.fn<Logger["debug"]>(),
      info: vi.fn<Logger["info"]>(),
      warn: vi.fn<Logger["warn"]>(),
      error: vi.fn<Logger["error"]>(() => Promise.reject(terminalFailure)),
    } satisfies Logger;
    const { host, generation, operations } = await createFixture({ onError: reporter, logger });
    const operation = Promise.withResolvers<object>();
    const started = Promise.withResolvers<void>();
    const unhandled = vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
    process.on("unhandledRejection", unhandled);
    generation.spawn(() =>
      acquireForLifetime(
        generation,
        operations,
        () => {
          started.resolve();
          return operation.promise;
        },
        vi.fn<(value: object) => void>(),
      ),
    );
    try {
      await started.promise;
      const stopping = host.stop();
      await setImmediate();
      operation.reject(failure);
      await stopping;
      await setImmediate();

      expect(reporter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: failure }));
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "Host error reporter failed",
          errors: [reporter.mock.calls[0]?.[0], reporterFailure],
        }),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      operation.resolve({ id: "cleanup" });
      await host.stop();
      await setImmediate();
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it.each([false, true])(
    "reclaims a resource rejected by the cleanup registration boundary (release fails: %s)",
    async (releaseFails) => {
      const { host, generation, operations, report } = await createFixture();
      const registrationFailure = new Error("cleanup registration failed");
      const releaseFailure = new Error("reclamation failed");
      const resource = { id: "unregistered" };
      const refusingGeneration = {
        signal: generation.signal,
        defer() {
          throw registrationFailure;
        },
      };
      const dispose = vi.fn<(value: object) => void | Promise<never>>(() => {
        if (releaseFails) return Promise.reject(releaseFailure);
        return undefined;
      });
      try {
        const result = await acquireForLifetime(
          refusingGeneration,
          operations,
          () => Promise.resolve(resource),
          dispose,
        );
        expect(result.status).toBe("failed");
        if (result.status !== "failed") throw new Error("Expected a failed acquisition");
        const cause = (result.error as Error).cause;
        const failures = cause instanceof AggregateError ? cause.errors : [cause];
        expect(cause).toBeInstanceOf(releaseFails ? AggregateError : Error);
        expect(failures).toEqual(
          releaseFails ? [registrationFailure, releaseFailure] : [registrationFailure],
        );
        expect(report).toHaveBeenCalledExactlyOnceWith(result.error);
        await generation[Symbol.asyncDispose]();
        await expect(
          Promise.allSettled([operations[Symbol.asyncDispose]()]),
        ).resolves.toMatchObject([
          releaseFails
            ? { status: "rejected", reason: { errors: [releaseFailure] } }
            : { status: "fulfilled" },
        ]);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
      } finally {
        await expect(Promise.allSettled([host.stop()])).resolves.toMatchObject([
          releaseFails
            ? { status: "rejected", reason: { code: "HOST_QUARANTINED" } }
            : { status: "fulfilled" },
        ]);
      }
    },
  );

  it("leaves accepted cleanup failures in the generation's existing aggregate", async () => {
    const { host, generation, operations, report } = await createFixture();
    const firstFailure = new Error("first cleanup failed");
    const secondFailure = new Error("second cleanup failed");
    const released: number[] = [];
    try {
      await acquireForLifetime(
        generation,
        operations,
        () => Promise.resolve(1),
        (value) => {
          released.push(value);
          throw firstFailure;
        },
      );
      await acquireForLifetime(
        generation,
        operations,
        () => Promise.resolve(2),
        (value) => {
          released.push(value);
          return Promise.reject(secondFailure);
        },
      );

      await expect(generation[Symbol.asyncDispose]()).rejects.toMatchObject({
        message: "Lifetime has unresolved cleanup obligations",
        errors: [secondFailure, firstFailure],
      });
      expect(released).toEqual([2, 1]);
      expect(report).not.toHaveBeenCalled();
    } finally {
      await expect(host.stop()).rejects.toMatchObject({
        code: "HOST_QUARANTINED",
        details: { outcome: "quarantined" },
      });
    }
  });
});

describe("application-selected identity queues", () => {
  it("keeps real operations serial per identity while other identities advance", async () => {
    const { host, owner, generation, operations, report } = await createFixture();
    const firstIdentity = new SerialQueue();
    const secondIdentity = new SerialQueue();
    const operation = Promise.withResolvers<void>();
    const trace: string[] = [];
    const delivered: string[] = [];
    const dispose = vi.fn<(value: string) => void>();
    const firstStart = vi.fn<() => Promise<string>>(() =>
      firstIdentity.run(async () => {
        trace.push("a:first:start");
        await operation.promise;
        trace.push("a:first:end");
        return "a:first";
      }),
    );
    const first = generation.spawn(async () => {
      const result = await acquireForLifetime(generation, operations, firstStart, dispose);
      if (result.status === "acquired") delivered.push(result.value);
    });
    try {
      await setImmediate();
      expect(trace).toEqual(["a:first:start"]);
      let retired = false;
      const retirement = generation[Symbol.asyncDispose]().then(() => {
        retired = true;
      });
      await setImmediate();
      expect(retired).toBe(true);
      await retirement;
      await expect(first.result).rejects.toBe(generation.signal.reason);

      const next = owner.child("next-generation");
      const second = next.spawn(async () => {
        const result = await acquireForLifetime(
          next,
          operations,
          () =>
            firstIdentity.run(() => {
              trace.push("a:second:start");
              return "a:second";
            }),
          dispose,
        );
        if (result.status === "acquired") delivered.push(result.value);
      });
      const other = next.spawn(async () => {
        const result = await acquireForLifetime(
          next,
          operations,
          () =>
            secondIdentity.run(() => {
              trace.push("b:first:start");
              return "b:first";
            }),
          dispose,
        );
        if (result.status === "acquired") delivered.push(result.value);
      });
      await other.result;
      expect(trace).toEqual(["a:first:start", "b:first:start"]);
      expect(delivered).toEqual(["b:first"]);

      operation.resolve();
      await second.result;
      await Promise.all([firstIdentity.settled, secondIdentity.settled]);
      expect(trace).toEqual(["a:first:start", "b:first:start", "a:first:end", "a:second:start"]);
      expect(delivered).toEqual(["b:first", "a:second"]);
      expect(dispose).toHaveBeenCalledExactlyOnceWith("a:first");
      expect(firstStart).toHaveBeenCalledOnce();
      expect(report).not.toHaveBeenCalled();
    } finally {
      operation.resolve();
      await host.stop();
    }
  });
});
