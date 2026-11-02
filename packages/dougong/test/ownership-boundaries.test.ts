import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  extensionPoint,
  service,
  DougongError,
  type PluginContext,
  type Task,
} from "../src";

it.each(["historical failure", "prototype", "constructor"])(
  "keeps cleanup outcome authority out of an external error's %s",
  async (source) => {
    const failedHost = createHost({
      installations: [
        {
          id: "failure",
          plugin: definePlugin({
            name: "owned.previous-cleanup-failure",
            setup(context) {
              context.lifetime.defer(() => {
                throw new Error("previous cleanup failed");
              });
              throw new Error("previous setup failed");
            },
          }),
        },
      ],
    });
    const historical = await failedHost.start().catch((error: unknown) => error);
    const value = service<number>("owned/cleanup-outcome");
    const original = definePlugin({
      name: "owned.cleanup-outcome",
      provides: { value },
      setup: () => ({ value: 1 }),
    });
    const host = createHost({ installations: [{ id: "owner", plugin: original }] });
    const installation = host.installation("owner")!;
    await host.start();
    const failure =
      source === "historical failure"
        ? historical
        : source === "constructor"
          ? new DougongError("HOST_QUARANTINED", "external cleanup claim", {
              details: { outcome: "quarantined" },
            })
          : Object.setPrototypeOf(
              new Error("setup failed cleanly"),
              Object.getPrototypeOf(historical),
            );
    const change = host.change();
    change.update(installation, {
      plugin: definePlugin({
        name: original.name,
        provides: { value },
        setup() {
          throw failure;
        },
      }),
    });
    const rejected = await host.apply(await host.plan(change)).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "TRANSITION_FAILED", details: { outcome: "restored" } });
    expect(Object.is((rejected as Error).cause, failure)).toBe(true);
    expect(host.status).toBe("running");
    expect(await host.use(value, (current) => current)).toBe(1);
    expect(installation.status).toBe("running");
    await host.stop();
  },
);

it("withdraws setup resources after an inaccessible non-Error rejection", async () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const released = vi.fn<() => void>();
  const host = createHost();
  await host.start();
  const change = host.change();
  const installation = change.install(
    definePlugin({
      name: "owned.inaccessible-rejection",
      setup(context) {
        context.lifetime.defer(released);
        throw reason.proxy;
      },
    }),
    { id: "candidate" },
  );
  const failure = await host.apply(await host.plan(change)).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
  expect(released).toHaveBeenCalledOnce();
  expect(installation.status).toBe("removed");
  expect(host.diagnostics.get().installations).toEqual([]);
  expect(host.status).toBe("running");
  await host.stop();
});

it("preserves an inaccessible Task rejection that occurs after cancellation", async () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const reports: unknown[] = [];
  let task!: Task;
  const host = createHost({
    onError: (error) => {
      reports.push(error);
    },
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owned.inaccessible-task",
          setup(context) {
            task = context.lifetime.spawn(async (signal) => {
              signal.addEventListener("abort", () => aborted.resolve(), { once: true });
              entered.resolve();
              await completion.promise;
            });
          },
        }),
      },
    ],
  });
  await host.start();
  await entered.promise;
  const result = task.result.then(
    () => false,
    (error: unknown) => Object.is(error, reason.proxy),
  );
  const stopping = host.stop();
  await aborted.promise;
  completion.reject(reason.proxy);
  await stopping;
  expect(await result).toBe(true);
  expect(reports).toHaveLength(1);
  expect(Object.is(reports[0], reason.proxy)).toBe(true);
});

it("discards a rejected Installation even when its original failure has an inaccessible cause", async () => {
  const cause = Proxy.revocable({}, {});
  cause.revoke();
  const failure = new Error("original setup failure", { cause: cause.proxy });
  const host = createHost();
  await host.start();
  const change = host.change();
  const installation = change.install(
    definePlugin({
      name: "owned.inaccessible-failure",
      setup() {
        throw failure;
      },
    }),
    { id: "candidate" },
  );
  const rejected = await host.apply(await host.plan(change)).catch((error: unknown) => error);
  expect(Object.is((rejected as Error).cause, failure)).toBe(true);
  expect(installation.status).toBe("removed");
  expect(host.diagnostics.get().error?.message).toBe("original setup failure");
  expect(host.diagnostics.get().installations).toEqual([]);
  expect(host.status).toBe("running");
  await host.stop();
});

it("keeps committed membership and revision behind a parent removal transaction", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host = createHost({
    groups: [{ id: "child" }],
    installations: [
      {
        id: "owner",
        groupId: "child",
        plugin: definePlugin({
          name: "owned.child",
          setup(context) {
            context.lifetime.defer(async () => {
              entered.resolve();
              await resume.promise;
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const installation = host.installation("owner")!;
  const child = host.group("child")!;
  const change = host.change();
  change.remove(installation);
  const applying = host.apply(await host.plan(change));
  await entered.promise;
  expect(host.stateRevision).toBe(revision);
  expect(host.installation("owner")).toBe(installation);
  expect(host.group("child")).toBe(child);
  expect(
    host.diagnostics.get().installations.find((record) => record.id === installation.id)?.status,
  ).toBe("changing");
  resume.resolve();
  await applying;
  expect(host.stateRevision).toBe(revision + 1);
  expect(host.group("child")).toBe(child);
  expect(host.diagnostics.get().installations).toEqual([]);
  await host.stop();
});

it("includes empty descendants in an explicitly planned subtree removal", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host = createHost({
    groups: [{ id: "parent" }, { id: "empty", parentId: "parent" }],
    installations: [
      {
        id: "owner",
        groupId: "parent",
        plugin: definePlugin({
          name: "owned.parent",
          setup(context) {
            context.lifetime.defer(async () => {
              entered.resolve();
              await resume.promise;
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const parent = host.group("parent")!;
  const child = host.group("empty")!;
  const change = host.change();
  change.removeGroup(parent);
  const removing = host.apply(await host.plan(change));
  await entered.promise;
  expect(host.group("parent")).toBe(parent);
  expect(host.group("empty")).toBe(child);
  resume.resolve();
  await removing;
  expect(host.group("parent")).toBeUndefined();
  expect(host.group("empty")).toBeUndefined();
  expect(child).toMatchObject({ id: "empty", parentId: "parent" });
  await host.stop();
});

it.each([false, true])(
  "reads only committed declarations during rejected validation (eager: %s)",
  async (eager) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const oldService = service<number>("owned/old");
    const nextService = service<number>("owned/next");
    const host = createHost({
      installations: [
        {
          id: "provider",
          plugin: definePlugin({
            name: "owned.provider",
            provides: { value: oldService },
            setup: () => ({ value: 1 }),
          }),
        },
      ],
    });
    await host.start();
    const installation = host.installation("provider")!;
    const revision = host.stateRevision;
    const snapshots: ReturnType<typeof host.diagnostics.get>[] = [];
    const subscription = eager
      ? host.diagnostics.subscribe(() => {
          snapshots.push(host.diagnostics.get());
        })
      : undefined;
    const change = host.change();
    change.update(installation, {
      plugin: definePlugin({
        name: "owned.provider",
        provides: { value: nextService },
        configuration: {
          "~standard": {
            version: 1,
            vendor: "test",
            async validate() {
              entered.resolve();
              await resume.promise;
              return { issues: [{ message: "rejected" }] };
            },
          },
        },
        setup: () => ({ value: 2 }),
      }),
      configuration: undefined,
    });
    const planning = host.plan(change).catch((error: unknown) => error);
    await entered.promise;
    const snapshot = host.diagnostics.get();
    expect(
      snapshot.installations.find((record) => record.id === installation.id)?.provides,
    ).toEqual([oldService.id]);
    expect(snapshots.at(-1) ?? snapshot).toBe(snapshot);
    expect(host.status).toBe("running");
    resume.resolve();
    expect(await planning).toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(host.stateRevision).toBe(revision);
    expect(await host.use(oldService, (value) => value)).toBe(1);
    subscription?.[Symbol.dispose]();
    await host.stop();
  },
);

it("captures ContributionStore identity independently of a mutable input token", async () => {
  const original = extensionPoint<number>("owned/items");
  const mutable = { ...original };
  let retainedContext!: PluginContext<{}>;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owned.contributor",
          setup(context) {
            retainedContext = context;
          },
        }),
      },
    ],
  });
  await host.start();
  const first = retainedContext.contributions.add(mutable, "first", 1);
  mutable.id = "owned/changed";
  first[Symbol.dispose]();
  const second = retainedContext.contributions.add(original, "second", 2);
  expect(await host.contributions(original).use("owner/second", (value) => [value])).toEqual([2]);
  second[Symbol.dispose]();
  await host.stop();
});

it("preserves independent sibling failures even when one is an AbortError", async () => {
  const failures = [new Error("independent A"), new DOMException("independent B", "AbortError")];
  const aborted: boolean[] = [];
  const host = createHost({
    installations: failures.map((failure, index) => ({
      id: `failure-${index}`,
      plugin: definePlugin({
        name: `owned.failure.${index}`,
        setup(context) {
          aborted.push(context.lifetime.signal.aborted);
          throw failure;
        },
      }),
    })),
  });
  await expect(host.start()).rejects.toMatchObject({
    cause: { errors: failures },
    details: { outcome: "restored" },
  });
  expect(aborted).toEqual([false, false]);
});

it.each([false, true])(
  "reports an independent Task failure when disposal overtakes its result reaction (async: %s)",
  async (asynchronous) => {
    const failure = new DOMException("independent task", "AbortError");
    const report = vi.fn<(error: unknown) => void>();
    const entered = Promise.withResolvers<void>();
    let task!: Task;
    const host = createHost({
      onError: report,
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owned.task",
            setup(context) {
              const fail = (signal: AbortSignal): never => {
                expect(signal.aborted).toBe(false);
                entered.resolve();
                throw failure;
              };
              task = context.lifetime.spawn(asynchronous ? async (signal) => fail(signal) : fail);
            },
          }),
        },
      ],
    });
    const started = host.start();
    await entered.promise;
    const disposed = task[Symbol.asyncDispose]();
    await expect(task.result).rejects.toBe(failure);
    await disposed;
    await started;
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await host.stop();
  },
);

it("reports a Task's AbortError when only its public signal properties claim cancellation", async () => {
  const failure = new DOMException("independent failure", "AbortError");
  const report = vi.fn<(error: unknown) => void>();
  let task!: Task;
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            task = lifetime.spawn((signal) => {
              Object.defineProperty(signal, "aborted", { value: true });
              throw failure;
            });
          },
        }),
      },
    ],
  });
  await host.start();
  await expect(task.result).rejects.toBe(failure);
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  await host.stop();
});

it("keeps independently disposed Tasks from sharing cancellation provenance", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const previousCancellation = Promise.withResolvers<unknown>();
  const rejected = Promise.withResolvers<void>();
  let first!: Task;
  let second!: Task;
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            first = lifetime.spawn(
              (signal) =>
                new Promise<void>((_resolve, reject) => {
                  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                }),
            );
            second = lifetime.spawn(async (signal) => {
              const reason = await previousCancellation.promise;
              expect(signal.aborted).toBe(false);
              rejected.resolve();
              throw reason;
            });
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    await first[Symbol.asyncDispose]();
    const reason: unknown = await first.result.catch((error: unknown) => error);
    previousCancellation.resolve(reason);
    await rejected.promise;
    const closing = second[Symbol.asyncDispose]();
    await expect(second.result).rejects.toBe(reason);
    await closing;
    expect(report).toHaveBeenCalledExactlyOnceWith(reason);
  } finally {
    previousCancellation.resolve(new Error("test finished"));
    await host.stop();
  }
});

it("retains an immutable historical snapshot while a removed Installation detaches", async () => {
  const host = createHost({
    installations: [{ id: "owner", plugin: definePlugin({ name: "owned.snapshot", setup() {} }) }],
  });
  await host.start();
  const installation = host.installation("owner")!;
  const previous = host.diagnostics.get();
  const states: string[] = [];
  using _subscription = host.diagnostics.subscribe(() => {
    states.push(installation.status);
  });
  const change = host.change();
  change.remove(installation);
  await host.apply(await host.plan(change));
  expect(states.at(-1)).toBe("removed");
  expect(installation.status).toBe("removed");
  expect(host.diagnostics.get().installations).toEqual([]);
  expect(previous.installations[0]?.status).toBe("running");
  expect(previous.installations[0]?.lifetime?.phase).toBe("active");
  await host.stop();
  expect(installation.status).toBe("removed");
});

it("does not let a removed Group handle address a new Group with the same id", async () => {
  const host = createHost({ groups: [{ id: "group" }] });
  const original = host.group("group")!;
  const removing = host.change();
  removing.removeGroup(original);
  await host.apply(await host.plan(removing));
  const replacing = host.change();
  const replacement = replacing.group("group");
  await host.apply(await host.plan(replacing));
  expect(replacement).not.toBe(original);
  const addition = host.change();
  const candidate = addition.install(definePlugin({ name: "owned.reused-group", setup() {} }), {
    id: "candidate",
    group: original,
  });
  await expect(host.plan(addition)).rejects.toMatchObject({ code: "GROUP_MISSING" });
  expect(candidate.status).toBe("removed");
  expect(host.group("group")).toBe(replacement);
  expect(host.installation("candidate")).toBeUndefined();
});
