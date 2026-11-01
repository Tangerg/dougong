import { expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
  type PluginContext,
  type Task,
} from "../src";

function failureMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  return [
    error.message,
    ...(error instanceof AggregateError ? error.errors.flatMap(failureMessages) : []),
    ...(error.cause === undefined ? [] : failureMessages(error.cause)),
  ];
}

it.each([false, true])(
  "preserves cleanup integrity across sibling failures (unclean: %s)",
  async (unclean) => {
    const starts = vi.fn<() => void>();
    const host = createHost({
      installations: [
        { id: "a", plugin: definePlugin({ name: "a", setup: starts }) },
        { id: "b", plugin: definePlugin({ name: "b", setup() {} }) },
      ],
    });
    await host.start();
    const changes = host.change();
    changes.update(host.installation("a")!, {
      plugin: definePlugin({
        name: "a",
        setup(ctx) {
          if (unclean)
            ctx.lifetime.defer(() => {
              throw new Error("cleanup failed");
            });
          throw new Error("a failed");
        },
      }),
    });
    changes.update(host.installation("b")!, {
      plugin: definePlugin({
        name: "b",
        setup() {
          throw new Error("b failed");
        },
      }),
    });
    const failure = await host.apply(await host.plan(changes)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ details: { outcome: unclean ? "quarantined" : "restored" } });
    expect(failureMessages(failure)).toEqual(
      expect.arrayContaining(
        unclean ? ["a failed", "b failed", "cleanup failed"] : ["a failed", "b failed"],
      ),
    );
    expect(host.status).toBe(unclean ? "quarantined" : "running");
    expect(starts).toHaveBeenCalledTimes(unclean ? 1 : 2);
    const stopped = await host.stop().catch((error: unknown) => error);
    expect(stopped).toMatchObject(
      unclean
        ? { code: "HOST_QUARANTINED" }
        : { stateRevision: host.stateRevision, affectedInstallations: ["a", "b"] },
    );
  },
);

it("keeps old Lifetime capabilities during rejected candidate validation", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const schema: StandardSchemaV1<boolean> = {
    "~standard": {
      version: 1,
      vendor: "test",
      async validate(value) {
        if (value === false) {
          entered.resolve();
          await resume.promise;
          return { issues: [{ message: "rejected" }] };
        }
        return { value: true };
      },
    },
  };
  const message = event<string>("message");
  const items = extensionPoint<string>("items");
  let ctx!: PluginContext<{}>;
  const stopped = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          setup(context) {
            ctx = context;
            ctx.lifetime.defer(stopped);
          },
        }),
      },
      { id: "b", plugin: definePlugin({ name: "b", config: schema, setup() {} }), config: true },
    ],
  });
  await host.start();
  const a = host.installation("a")!;
  const changes = host.change();
  changes.remove(a);
  changes.update(host.installation("b")!, { config: false });
  const rejected = host.plan(changes).catch((error: unknown) => error);
  await entered.promise;
  try {
    expect(ctx.lifetime.signal.aborted).toBe(false);
    const listener = vi.fn<(payload: string) => void>();
    ctx.events.on(message, listener);
    ctx.contributions.add(items, "old", "running");
    await ctx.events.emit(message, "still alive");
    expect(listener).toHaveBeenCalledWith("still alive");
    expect(stopped).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
  }
  expect(await rejected).toMatchObject({ code: "CONFIG_INVALID" });
  expect(host.status).toBe("running");
  expect(a.status).toBe("running");
  expect(await host.contributions(items).use(`${a.id}/old`, (value) => value)).toBe("running");
  await host.stop();
  await expect(ctx.events.emit(message, "too late")).rejects.toMatchObject({
    code: "LIFETIME_DISPOSED",
  });
  expect(() => ctx.events.on(message, () => undefined)).toThrow("closed");
  expect(() => ctx.contributions.add(items, "late", "no")).toThrow("closed");
});

it.each(["cleanup", "restore", "stop"] as const)(
  "quarantines the entire execution graph after %s cannot establish safe ownership",
  async (mode) => {
    const value = service<number>("value");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let failing = false;
    const provider = definePlugin({
      name: "provider",
      provides: { value },
      setup: () => ({ value: 1 }),
    });
    const host = createHost({
      installations: [
        { id: "provider", plugin: provider },
        {
          id: "consumer",
          plugin: definePlugin({
            name: "consumer",
            requires: { value },
            async setup(ctx) {
              const unclean = failing && mode === "cleanup";
              ctx.lifetime.defer(async () => {
                if (failing && mode === "stop") {
                  entered.resolve();
                  await resume.promise;
                  throw new Error("stop failed");
                }
                if (unclean) throw new Error("cleanup failed");
              });
              if (failing && mode !== "stop") {
                entered.resolve();
                await resume.promise;
                throw new Error("consumer failed");
              }
            },
          }),
        },
        { id: "unrelated", plugin: definePlugin({ name: "unrelated", setup() {} }) },
      ],
    });
    await host.start();
    failing = true;
    const changes = host.change();
    changes.update(host.installation("provider")!, { plugin: provider });
    const rejected = host.apply(await host.plan(changes)).catch((error: unknown) => error);
    await entered.promise;
    expect(host.status).toBe("changing");
    resume.resolve();
    expect(await rejected).toMatchObject({
      code: "HOST_QUARANTINED",
      details: { outcome: "quarantined" },
    });
    expect(host.status).toBe("quarantined");
    expect(
      host.diagnostics
        .get()
        .installations.every((installation) => installation.status === "quarantined"),
    ).toBe(true);
    await expect(host.use(value, (current) => current)).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
    });
    failing = false;
    await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  },
);

it("retains a Group's committed first change while a subsequent candidate rolls back", async () => {
  const host = createHost();
  await host.start();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const first = host.change();
  const group = first.group("new");
  first.install(
    definePlugin({
      name: "first",
      async setup() {
        entered.resolve();
        await resume.promise;
      },
    }),
    { id: "first", group },
  );
  const applying = host.apply(await host.plan(first));
  await entered.promise;
  expect(host.group("new")).toBeUndefined();
  expect(host.installation("first")).toBeUndefined();
  resume.resolve();
  await applying;
  const revision = host.stateRevision;
  const second = host.change();
  second.install(
    definePlugin({
      name: "second",
      setup() {
        throw new Error("second failed");
      },
    }),
    { id: "second", group },
  );
  await expect(host.apply(await host.plan(second))).rejects.toMatchObject({
    cause: { message: "second failed" },
    details: { outcome: "restored" },
  });
  expect(host.group("new")).toBe(group);
  expect(host.installation("first")?.status).toBe("running");
  expect(host.installation("second")).toBeUndefined();
  expect(host.stateRevision).toBe(revision + 1);
  await host.stop();
});

it.each(["install", "create", "remove"] as const)(
  "rejects concurrent child %s execution and then rejects its stale base revision",
  async (kind) => {
    const host = createHost({ groups: [{ id: "parent" }, { id: "child", parentId: "parent" }] });
    await host.start();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const blocking = host.change();
    blocking.install(
      definePlugin({
        name: "blocker",
        async setup() {
          entered.resolve();
          await resume.promise;
        },
      }),
      { id: "blocker" },
    );
    const applying = host.apply(await host.plan(blocking));
    await entered.promise;
    const child = host.group("child")!;
    const pending = host.change();
    const plugin = definePlugin({ name: "dynamic", setup() {} });
    if (kind === "install") pending.install(plugin, { id: "dynamic", group: child });
    else if (kind === "create") {
      const nested = pending.group("nested", child);
      pending.install(plugin, { id: "dynamic", group: nested });
    } else pending.removeGroup(child);
    const plan = await host.plan(pending);
    await expect(host.apply(plan)).rejects.toMatchObject({
      code: "HOST_BUSY",
      details: { outcome: "rejected" },
    });
    expect(host.group("child")).toBe(child);
    resume.resolve();
    await applying;
    await expect(host.apply(plan)).rejects.toMatchObject({
      code: "PLAN_STALE",
      details: { outcome: "rejected" },
    });
    expect(host.group("child")).toBe(child);
    expect(host.group("nested")).toBeUndefined();
    expect(host.installation("dynamic")).toBeUndefined();
    await host.stop();
  },
);

it("rejects a concurrent start and preserves quarantined ownership after the active attempt fails", async () => {
  const value = service<number>("queued/value");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const provider = definePlugin({
    name: "provider",
    provides: { value },
    setup: () => ({ value: 1 }),
  });
  let attempts = 0;
  const host = createHost({
    installations: [
      { id: "provider", plugin: provider },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value },
          async setup(ctx) {
            if (++attempts !== 2) return;
            ctx.lifetime.defer(() => {
              throw new Error("cleanup failed");
            });
            entered.resolve();
            await resume.promise;
            throw new Error("setup failed");
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("provider")!, { plugin: provider });
  const changed = host.apply(await host.plan(change)).catch((error: unknown) => error);
  await entered.promise;
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_BUSY" });
  resume.resolve();
  expect(await changed).toMatchObject({ code: "HOST_QUARANTINED" });
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(host.status).toBe("quarantined");
  expect(attempts).toBe(2);
});

it("retains a provider when its timed out consumer can still use its resources", async () => {
  const resource = service<{ read(): boolean }>("timeout/resource");
  const resume = Promise.withResolvers<void>();
  const release = vi.fn<() => void>();
  let alive = true;
  let task!: Task;
  const host = createHost({
    shutdownTimeoutMs: 5,
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "timeout.provider",
          provides: { resource },
          setup(ctx) {
            ctx.lifetime.defer(() => {
              alive = false;
              release();
            });
            return { resource: { read: () => alive } };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "timeout.consumer",
          requires: { resource },
          setup(ctx) {
            task = ctx.lifetime.spawn(async () => {
              await resume.promise;
              expect(ctx.deps.resource.read()).toBe(true);
            });
          },
        }),
      },
    ],
  });
  await host.start();
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(release).not.toHaveBeenCalled();
  expect(host.diagnostics.get().unresolved.map((record) => record.installation)).toEqual(
    expect.arrayContaining(["provider", "consumer"]),
  );
  resume.resolve();
  await task.result;
  expect(release).not.toHaveBeenCalled();
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
});

it("reports late setup failure and refreshes unresolved ownership after the deadline", async () => {
  const lateFailure = new Error("late setup failure");
  const resume = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    shutdownTimeoutMs: 5,
    onError: report,
    installations: [
      {
        id: "first",
        plugin: definePlugin({
          name: "deadline.first",
          setup() {
            throw new Error("first setup failure");
          },
        }),
      },
      {
        id: "late",
        plugin: definePlugin({
          name: "deadline.late",
          async setup() {
            try {
              await resume.promise;
              throw lateFailure;
            } finally {
              finished.resolve();
            }
          },
        }),
      },
    ],
  });
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  const before = host.diagnostics.get();
  expect(before.unresolved.find((record) => record.installation === "late")?.lifetime.tasks).toBe(
    1,
  );
  resume.resolve();
  await finished.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = host.diagnostics.get();
  expect(report).toHaveBeenCalledExactlyOnceWith(lateFailure);
  expect(after).not.toBe(before);
  expect(after.stateRevision).toBe(before.stateRevision);
  expect(after.status).toBe("quarantined");
  expect(after.unresolved.some((record) => record.installation === "late")).toBe(false);
});

it("rejects lifecycle reentry from startup validation and releases execution ownership after validation failure", async () => {
  let host!: ReturnType<typeof createHost>;
  let tolerateBusy = false;
  const failures: unknown[] = [];
  const setup = vi.fn<() => void>();
  const plugin = definePlugin({
    name: "validation.reentry",
    config: {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate() {
          try {
            await host.stop();
          } catch (error) {
            failures.push(error);
            if (!tolerateBusy) throw error;
          }
          return { value: undefined };
        },
      },
    },
    setup,
  });
  host = createHost({ installations: [{ id: "owner", plugin }] });
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_BUSY" });
  expect(host.status).toBe("stopped");
  expect(host.stateRevision).toBe(0);
  expect(setup).not.toHaveBeenCalled();
  tolerateBusy = true;
  await expect(host.start()).resolves.toEqual({
    stateRevision: 1,
    affectedInstallations: ["owner"],
  });
  expect(failures).toEqual([
    expect.objectContaining({ code: "HOST_BUSY" }),
    expect.objectContaining({ code: "HOST_BUSY" }),
  ]);
  expect(host.status).toBe("running");
  expect(setup).toHaveBeenCalledOnce();
  await host.stop();
});

it("consumes a stale Plan and detaches the Installation identities it can no longer commit", async () => {
  const host = createHost();
  const change = host.change();
  const candidate = change.install(definePlugin({ name: "plan.stale-candidate", setup() {} }), {
    id: "candidate",
  });
  const plan = await host.plan(change);
  await host.start();
  expect(candidate.status).toBe("removed");
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_STALE" });
  expect(host.installation("candidate")).toBeUndefined();
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_CONSUMED" });
  await host.stop();
});

it.each([false, true])(
  "rejects validation that outlives its base state (quarantine: %s)",
  async (quarantine) => {
    const validating = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            setup({ lifetime }) {
              if (quarantine)
                lifetime.defer(() => {
                  throw new Error("unclean");
                });
            },
          }),
        },
      ],
    });
    await host.start();
    const revision = host.stateRevision;
    const change = host.change();
    const candidate = change.install(
      definePlugin({
        name: "candidate",
        config: {
          "~standard": {
            version: 1,
            vendor: "test",
            async validate() {
              validating.resolve();
              await finish.promise;
              return { value: null };
            },
          },
        },
        setup() {},
      }),
      { id: "candidate", config: null },
    );
    const planning = host.plan(change);
    await validating.promise;
    await host.stop().catch((error: unknown) => {
      if (!quarantine) throw error;
    });
    finish.resolve();
    await expect(planning).rejects.toMatchObject(
      quarantine
        ? { code: "HOST_QUARANTINED", details: { stateRevision: host.stateRevision } }
        : {
            code: "PLAN_STALE",
            details: { expectedRevision: revision, stateRevision: host.stateRevision },
          },
    );
    expect(candidate.status).toBe("removed");
  },
);

it.each([false, true])(
  "retires validation immediately when its revision ends (quarantine: %s)",
  async (quarantine) => {
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const later = vi.fn<() => { value: null }>(() => ({ value: null }));
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            setup({ lifetime }) {
              if (quarantine)
                lifetime.defer(() => {
                  throw new Error("cleanup failed");
                });
            },
          }),
        },
      ],
    });
    await host.start();
    const change = host.change();
    for (const [id, validate] of [
      [
        "blocked",
        async () => {
          entered.resolve();
          await blocked.promise;
          return { value: null };
        },
      ],
      ["later", later],
    ] as const) {
      change.install(
        definePlugin({
          name: id,
          config: { "~standard": { version: 1, vendor: "test", validate } },
          setup() {},
        }),
        { id, config: null },
      );
    }
    const reason = vi.fn<(error: unknown) => void>();
    const done = host.plan(change).then(() => {
      throw new Error("Obsolete plan issued");
    }, reason);
    try {
      await entered.promise;
      await Promise.allSettled([host.stop()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reason).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: quarantine ? "HOST_QUARANTINED" : "PLAN_STALE" }),
      );
    } finally {
      blocked.resolve();
      await done;
    }
    expect(later).not.toHaveBeenCalled();
  },
);

it("opens contribution publication before announcing an admitted transition to observers", async () => {
  const point = extensionPoint<number>("publication/at-ingress");
  let add!: () => void;
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ contributions }) {
            add = () => {
              contributions.add(point, "later", 1);
            };
          },
        }),
      },
    ],
  });
  await host.start();
  const view = host.contributions(point);
  const before = view.get();
  const change = host.change();
  change.install(
    definePlugin({
      name: "joining",
      async setup() {
        entered.resolve();
        await finish.promise;
      },
    }),
    { id: "joining" },
  );
  const plan = await host.plan(change);
  let added = false;
  const watching = host.diagnostics.subscribe(() => {
    if (host.status === "changing" && !added) {
      added = true;
      add();
    }
  });
  const applying = host.apply(plan);
  try {
    await entered.promise;
    expect(added).toBe(true);
    expect(view.get()).toBe(before);
    await expect(view.use("owner/later", (v) => v)).rejects.toMatchObject({
      code: "CONTRIBUTION_UNAVAILABLE",
    });
  } finally {
    watching[Symbol.dispose]();
    finish.resolve();
    await applying;
  }
  expect(view.get()).toEqual(["owner/later"]);
  await host.stop();
});
