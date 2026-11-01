import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  optional,
  service,
  type ChildLifetime,
  type Task,
} from "../src/index";

function failures(error: unknown): unknown[] {
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(failures) : []),
    ...(error instanceof Error && error.cause !== undefined ? failures(error.cause) : []),
  ];
}

it("releases independent branches while retaining a failed consumer's transitive providers", async () => {
  const root = service<number>("release/root");
  const middle = service<number>("release/middle");
  const independent = service<number>("release/independent");
  const released: string[] = [];
  const host = createHost({
    installations: [
      {
        id: "root",
        plugin: definePlugin({
          name: "root",
          provides: { root },
          setup({ lifetime }) {
            lifetime.defer(() => {
              released.push("root");
            });
            return { root: 1 };
          },
        }),
      },
      {
        id: "independent-provider",
        plugin: definePlugin({
          name: "independent-provider",
          provides: { independent },
          setup({ lifetime }) {
            lifetime.defer(() => {
              released.push("independent-provider");
            });
            return { independent: 2 };
          },
        }),
      },
      {
        id: "middle",
        plugin: definePlugin({
          name: "middle",
          requires: { root },
          provides: { middle },
          setup({ deps, lifetime }) {
            lifetime.defer(() => {
              released.push("middle");
            });
            return { middle: deps.root };
          },
        }),
      },
      {
        id: "independent-consumer",
        plugin: definePlugin({
          name: "independent-consumer",
          requires: { independent },
          setup({ lifetime }) {
            lifetime.defer(() => {
              released.push("independent-consumer");
            });
          },
        }),
      },
      {
        id: "failed-consumer",
        plugin: definePlugin({
          name: "failed-consumer",
          requires: { middle },
          setup({ lifetime }) {
            lifetime.defer(() => {
              released.push("failed-consumer");
              throw new Error("consumer cleanup failed");
            });
          },
        }),
      },
    ],
  });
  await host.start();
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(released).toEqual(["failed-consumer", "independent-consumer", "independent-provider"]);
  expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
    "root",
    "middle",
    "failed-consumer",
  ]);
});

it("aggregates independent cleanup failures once while continuing safe teardown", async () => {
  const first = new Error("first cleanup failure");
  const second = new Error("second cleanup failure");
  const clean = vi.fn<() => void>();
  const releaseFirst = vi.fn<() => never>(() => {
    throw first;
  });
  const releaseSecond = vi.fn<() => never>(() => {
    throw second;
  });
  const host = createHost({
    installations: [
      {
        id: "clean",
        plugin: definePlugin({
          name: "clean",
          setup: ({ lifetime }) => {
            lifetime.defer(clean);
          },
        }),
      },
      {
        id: "first",
        plugin: definePlugin({
          name: "first",
          setup: ({ lifetime }) => {
            lifetime.defer(releaseFirst);
          },
        }),
      },
      {
        id: "second",
        plugin: definePlugin({
          name: "second",
          setup: ({ lifetime }) => {
            lifetime.defer(releaseSecond);
          },
        }),
      },
    ],
  });
  await host.start();
  const error = await host.stop().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "HOST_QUARANTINED" });
  expect(failures(error).filter((cause) => cause === first)).toHaveLength(1);
  expect(failures(error).filter((cause) => cause === second)).toHaveLength(1);
  expect(clean).toHaveBeenCalledOnce();
  expect(releaseFirst).toHaveBeenCalledOnce();
  expect(releaseSecond).toHaveBeenCalledOnce();
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(releaseFirst).toHaveBeenCalledOnce();
  expect(releaseSecond).toHaveBeenCalledOnce();
});

it("retains the previous optional binding after removal fails and drains unaffected instances", async () => {
  const value = service<number>("release/optional");
  const releaseProvider = vi.fn<() => void>();
  const releaseUnrelated = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(releaseProvider);
            return { value: 1 };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value: optional(value) },
          setup({ deps, lifetime }) {
            lifetime.defer(() => {
              expect(deps.value).toBe(1);
              throw new Error("old consumer failed");
            });
          },
        }),
      },
      {
        id: "unrelated",
        plugin: definePlugin({
          name: "unrelated",
          setup({ lifetime }) {
            lifetime.defer(releaseUnrelated);
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.remove(host.installation("provider")!);
  const plan = await host.plan(change);
  expect(plan.report.bindings.after[0]?.provider).toBeUndefined();
  await expect(host.apply(plan)).rejects.toMatchObject({
    details: { outcome: "quarantined", phase: "stop" },
  });
  expect(releaseProvider).not.toHaveBeenCalled();
  expect(releaseUnrelated).toHaveBeenCalledOnce();
  expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
    "provider",
    "consumer",
  ]);
});

it("retains a failed candidate's actual provider generation instead of its previous binding", async () => {
  const a = service<number>("release/a");
  const b = service<number>("release/b");
  const releaseA = vi.fn<() => void>();
  const releaseB = vi.fn<() => void>();
  const releaseOld = vi.fn<() => void>();
  const releaseNew = vi.fn<() => never>(() => {
    throw new Error("new cleanup failed");
  });
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          provides: { a },
          setup({ lifetime }) {
            lifetime.defer(releaseA);
            return { a: 1 };
          },
        }),
      },
      {
        id: "b",
        plugin: definePlugin({
          name: "b",
          provides: { b },
          setup({ lifetime }) {
            lifetime.defer(releaseB);
            return { b: 2 };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "old",
          requires: { a },
          setup({ lifetime }) {
            lifetime.defer(releaseOld);
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("consumer")!, {
    plugin: definePlugin({
      name: "new",
      requires: { b },
      setup({ deps, lifetime }) {
        expect(deps.b).toBe(2);
        lifetime.defer(releaseNew);
        throw new Error("new setup failed");
      },
    }),
  });
  await expect(host.apply(await host.plan(change))).rejects.toMatchObject({
    details: { outcome: "quarantined", phase: "prepare" },
  });
  expect(releaseOld).toHaveBeenCalledOnce();
  expect(releaseNew).toHaveBeenCalledOnce();
  expect(releaseA).toHaveBeenCalledOnce();
  expect(releaseB).not.toHaveBeenCalled();
  expect(
    host.diagnostics
      .get()
      .unresolved.map(({ installation, generation }) => ({ installation, generation })),
  ).toEqual([
    { installation: "b", generation: 1 },
    { installation: "consumer", generation: 2 },
  ]);
});

it("drains independent startup candidates after a failed candidate cannot release", async () => {
  const value = service<number>("release/startup");
  const providerRelease = vi.fn<() => void>();
  const independentRelease = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(providerRelease);
            return { value: 1 };
          },
        }),
      },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(independentRelease);
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value },
          setup({ lifetime }) {
            lifetime.defer(() => {
              throw new Error("startup cleanup failed");
            });
            throw new Error("startup failed");
          },
        }),
      },
    ],
  });
  await expect(host.start()).rejects.toMatchObject({
    details: { outcome: "quarantined", phase: "prepare" },
  });
  expect(independentRelease).toHaveBeenCalledOnce();
  expect(providerRelease).not.toHaveBeenCalled();
  expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
    "provider",
    "consumer",
  ]);
});

it("uses restored declarations when restoration cleanup retains a dependency", async () => {
  const a = service<number>("release/restore-a");
  const b = service<number>("release/restore-b");
  const releaseA = vi.fn<() => void>();
  const releaseB = vi.fn<() => void>();
  const releaseIndependent = vi.fn<() => void>();
  const restorationFailure = new Error("restored cleanup failed");
  let attempts = 0;
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          provides: { a },
          setup({ lifetime }) {
            lifetime.defer(releaseA);
            return { a: 1 };
          },
        }),
      },
      {
        id: "b",
        plugin: definePlugin({
          name: "b",
          provides: { b },
          setup({ lifetime }) {
            lifetime.defer(releaseB);
            return { b: 2 };
          },
        }),
      },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(releaseIndependent);
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "old",
          requires: { a },
          setup({ lifetime }) {
            if (++attempts === 1) return;
            lifetime.defer(() => {
              throw restorationFailure;
            });
            throw new Error("restored setup failed");
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("consumer")!, {
    plugin: definePlugin({
      name: "new",
      requires: { b },
      setup() {
        throw new Error("candidate failed");
      },
    }),
  });
  const error = await host.apply(await host.plan(change)).catch((error: unknown) => error);
  expect(error).toMatchObject({ details: { outcome: "quarantined", phase: "restore" } });
  expect(failures(error).filter((cause) => cause === restorationFailure)).toHaveLength(1);
  expect(releaseA).not.toHaveBeenCalled();
  expect(releaseB).toHaveBeenCalledOnce();
  expect(releaseIndependent).toHaveBeenCalledOnce();
  expect(
    host.diagnostics
      .get()
      .unresolved.map(({ installation, generation }) => ({ installation, generation })),
  ).toEqual([
    { installation: "a", generation: 1 },
    { installation: "consumer", generation: 3 },
  ]);
});

it("retains a busy unrelated borrower and its providers without deadlocking quarantine", async () => {
  const provider = service<number>("release/busy-provider");
  const consumer = service<number>("release/busy-consumer");
  const releaseProvider = vi.fn<() => void>();
  const releaseConsumer = vi.fn<() => void>();
  const releaseIndependent = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { provider },
          setup({ lifetime }) {
            lifetime.defer(releaseProvider);
            return { provider: 1 };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { provider },
          provides: { consumer },
          setup({ deps, lifetime }) {
            lifetime.defer(releaseConsumer);
            return { consumer: deps.provider };
          },
        }),
      },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(releaseIndependent);
          },
        }),
      },
      {
        id: "failure",
        plugin: definePlugin({
          name: "failure",
          setup({ lifetime }) {
            lifetime.defer(() => {
              throw new Error("stop failed");
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.remove(host.installation("failure")!);
  const plan = await host.plan(change);
  const error = await host.use(consumer, async (value) => {
    expect(value).toBe(1);
    return host.apply(plan).catch((error: unknown) => error);
  });
  expect(error).toMatchObject({ details: { outcome: "quarantined", phase: "stop" } });
  expect(releaseIndependent).toHaveBeenCalledOnce();
  expect(releaseProvider).not.toHaveBeenCalled();
  expect(releaseConsumer).not.toHaveBeenCalled();
  expect(new Set(host.diagnostics.get().unresolved.map((entry) => entry.installation))).toEqual(
    new Set(["provider", "consumer", "failure"]),
  );
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(releaseConsumer).not.toHaveBeenCalled();
});

it("retains a timed out consumer while releasing independent work", async () => {
  vi.useFakeTimers();
  const value = service<number>("release/timeout");
  const releaseProvider = vi.fn<() => void>();
  const releaseIndependent = vi.fn<() => void>();
  const resume = Promise.withResolvers<void>();
  let task!: Task;
  const host = createHost({
    shutdownTimeoutMs: 5,
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(releaseProvider);
            return { value: 1 };
          },
        }),
      },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(releaseIndependent);
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value },
          setup({ lifetime }) {
            task = lifetime.spawn(async () => {
              await resume.promise;
            });
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    const stopping = host.stop().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    expect(await stopping).toMatchObject({ code: "HOST_QUARANTINED" });
    expect(releaseIndependent).toHaveBeenCalledOnce();
    expect(releaseProvider).not.toHaveBeenCalled();
    resume.resolve();
    await task.result;
    expect(releaseProvider).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "quarantines a rejected Contract admission only when candidate cleanup fails (unclean: %s)",
  async (unclean) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const cleanupFailure = new Error("candidate cleanup failed");
    const release = vi.fn<() => void>(() => {
      if (unclean) throw cleanupFailure;
    });
    const notification = event<void>("release/publication-conflict");
    const collision = extensionPoint<number>(notification.id);
    const host = createHost();
    await host.start();
    const change = host.change();
    change.install(
      definePlugin({
        name: "candidate",
        async setup({ events, lifetime }) {
          lifetime.defer(release);
          events.on(notification, () => undefined);
          entered.resolve();
          await resume.promise;
        },
      }),
      { id: "candidate" },
    );
    const changing = host.apply(await host.plan(change)).catch((error: unknown) => error);
    await entered.promise;
    host.contributions(collision);
    resume.resolve();
    const error = await changing;
    expect(error).toMatchObject({
      details: { outcome: unclean ? "quarantined" : "restored", phase: "prepare" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(host.diagnostics.get().installations).toEqual([]);
    expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual(
      unclean ? ["candidate"] : [],
    );
    expect(failures(error).filter((cause) => cause === cleanupFailure)).toHaveLength(
      unclean ? 1 : 0,
    );
  },
);

it("joins an already running shutdown without retrying it or quarantining successful release", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const cleanup = vi.fn<() => Promise<void>>(async () => {
    entered.resolve();
    await resume.promise;
  });
  let child!: ChildLifetime;
  const host = createHost({
    installations: [
      {
        id: "plugin",
        plugin: definePlugin({
          name: "plugin",
          setup(ctx) {
            child = ctx.lifetime.child("plugin-owned");
            child.defer(cleanup);
          },
        }),
      },
    ],
  });
  await host.start();
  const selfDisposal = child[Symbol.asyncDispose]();
  await entered.promise;
  const settled = vi.fn<() => void>();
  const stopping = host.stop().then(settled, settled);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(host.status).toBe("stopping");
  } finally {
    resume.resolve();
    await selfDisposal;
    await stopping;
  }
  expect(host.status).toBe("stopped");
  expect(cleanup).toHaveBeenCalledOnce();
  expect(host.diagnostics.get().unresolved).toEqual([]);
});

it("starts independent shutdown branches while protecting a provider until its last consumer finishes", async () => {
  const value = service<number>("stop/value");
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(() => {
              order.push("provider");
            });
            return { value: 1 };
          },
        }),
      },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(() => {
              order.push("independent");
            });
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value },
          setup({ lifetime }) {
            lifetime.defer(async () => {
              waiting.resolve();
              await release.promise;
              order.push("consumer");
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const stopping = host.stop();
  try {
    await waiting.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect([...order]).toEqual(["independent"]);
  } finally {
    release.resolve();
    await stopping;
  }
  expect(order).toEqual(["independent", "consumer", "provider"]);
});
