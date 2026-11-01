import { expect, it, vi } from "vitest";
import { createHost, definePlugin, service } from "../src/index";

it("keeps quarantine terminal after its last pending release finishes", async () => {
  vi.useFakeTimers();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const cleanup = vi.fn<() => Promise<void>>(() => release.promise);
  const value = service<number>("terminal/value");
  const setup = vi.fn<() => void>();
  const host = createHost({
    shutdownTimeoutMilliseconds: 10,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          provides: { value },
          setup({ lifetime }) {
            setup();
            lifetime.defer(cleanup);
            return { value: 1 };
          },
        }),
      },
    ],
  });

  try {
    await host.start();
    const draft = host.change();
    const plan = await host.plan(host.change());
    const stopping = host.stop().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await stopping).toMatchObject({
      code: "HOST_QUARANTINED",
      details: { outcome: "quarantined", phase: "stop" },
    });
    const before = host.diagnostics.get();
    expect(before.unresolved).toHaveLength(1);
    using _subscription = host.diagnostics.subscribe(() => {
      if (host.diagnostics.get().unresolved.length === 0) settled.resolve();
    });
    release.resolve();
    await settled.promise;

    const after = host.diagnostics.get();
    expect(after).not.toBe(before);
    expect(after).toMatchObject({
      status: "quarantined",
      stateRevision: before.stateRevision,
      unresolved: [],
    });
    expect(host.installation("owner")?.status).toBe("quarantined");
    expect(() => host.change()).toThrowError(expect.objectContaining({ code: "HOST_QUARANTINED" }));
    for (const command of [
      () => host.plan(draft),
      () => host.apply(plan),
      () => host.start(),
      () => host.stop(),
      () => host[Symbol.asyncDispose](),
      () =>
        host.use(value, () => {
          throw new Error("borrow must not run");
        }),
    ]) {
      await expect(command()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    }
    expect(host.diagnostics.get()).toBe(after);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    vi.useRealTimers();
  }
});

it("distinguishes terminal restoration failure from unresolved resource ownership", async () => {
  const released: string[] = [];
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let starts = 0;
  const previous = definePlugin({
    name: "previous",
    setup({ lifetime }) {
      const generation = ++starts;
      lifetime.defer(() => {
        released.push(`previous:${generation}`);
      });
      if (generation > 1) throw new Error("restoration failed");
    },
  });
  const host = createHost({
    installations: [
      { id: "target", plugin: previous },
      {
        id: "independent",
        plugin: definePlugin({
          name: "independent",
          setup({ lifetime }) {
            lifetime.defer(async () => {
              entered.resolve();
              await resume.promise;
              released.push("independent");
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("target")!, {
    plugin: definePlugin({
      name: "replacement",
      setup({ lifetime }) {
        lifetime.defer(() => {
          released.push("replacement");
        });
        throw new Error("replacement failed");
      },
    }),
  });

  const changing = host.apply(await host.plan(change)).catch((error: unknown) => error);
  await entered.promise;
  try {
    expect(host.diagnostics.get().status).toBe("changing");
    expect(host.installation("target")?.status).toBe("changing");
    expect(host.diagnostics.get().installations.map((entry) => entry.status)).toEqual([
      "changing",
      "changing",
    ]);
  } finally {
    resume.resolve();
  }
  expect(await changing).toMatchObject({
    code: "HOST_QUARANTINED",
    details: { outcome: "quarantined", phase: "restore" },
  });
  expect(released).toEqual(["previous:1", "replacement", "previous:2", "independent"]);
  const snapshot = host.diagnostics.get();
  expect(snapshot).toMatchObject({ status: "quarantined", unresolved: [] });
  expect(snapshot.error?.message).not.toContain("unresolved release obligations");
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(starts).toBe(2);
});
