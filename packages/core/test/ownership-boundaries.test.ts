import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  extensionPoint,
  service,
  RecordedFailure,
  type Group,
  type Installation,
  type PluginContext,
  type Task,
} from "../src";

it.each(["historical failure", "prototype", "constructor"])(
  "keeps cleanup outcome authority out of an external error's %s",
  async (source) => {
    const failedHost = createHost();
    failedHost.install(
      definePlugin({
        name: "owned.previous-cleanup-failure",
        setup(ctx) {
          ctx.cleanup(() => {
            throw new Error("previous cleanup failed");
          });
          throw new Error("previous setup failed");
        },
      }),
    );
    const historical: unknown = await failedHost.start().catch((error: unknown) => error);
    const ErrorClass = (historical as Error).constructor as new (
      errors: ReadonlyArray<unknown>,
      message: string,
    ) => Error;
    const VALUE = service<number>("owned/cleanup-outcome");
    const provides = { value: VALUE };
    const host = createHost();
    const original = definePlugin({
      name: "owned.cleanup-outcome",
      provides,
      setup: () => ({ value: 1 }),
    });
    const installation = host.install(original);
    await host.start();
    const failure =
      source === "historical failure"
        ? historical
        : source === "constructor"
          ? new ErrorClass([], "setup failed cleanly")
          : Object.setPrototypeOf(
              new Error("setup failed cleanly"),
              Object.getPrototypeOf(historical),
            );
    const replacement = definePlugin({
      name: original.name,
      provides,
      setup() {
        throw failure;
      },
    });
    const rejected = await installation
      .update({ plugin: replacement })
      .catch((error: unknown) => error);

    expect(Object.is(rejected, failure)).toBe(true);
    expect(host.status).toBe("active");
    expect(host.get(VALUE)).toBe(1);
    expect(installation.status).toBe("active");
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
      setup(ctx) {
        ctx.cleanup(released);
        throw reason.proxy;
      },
    }),
  );

  const failure: unknown = await change.commit().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
  expect(released).toHaveBeenCalledTimes(1);
  expect(installation.status).toBe("failed");
  await expect(installation.ready()).rejects.toBeInstanceOf(RecordedFailure);
  expect(installation.diagnostics.get().error?.code).toBe("INSTALLATION_UNAVAILABLE");
  expect(host.diagnostics.get().installations.size).toBe(0);
  expect(host.status).toBe("active");
  await host.stop();
});

it("preserves an inaccessible Task rejection that occurs after cancellation", async () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const reports: unknown[] = [];
  const host = createHost({
    onError: (error) => {
      reports.push(error);
    },
  });
  let task!: Task;
  host.install(
    definePlugin({
      name: "owned.inaccessible-task",
      setup(ctx) {
        task = ctx.spawn(async (signal) => {
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          entered.resolve();
          await completion.promise;
        });
      },
    }),
  );
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
  );

  const rejected: unknown = await change.commit().catch((error: unknown) => error);
  expect(Object.is(rejected, failure)).toBe(true);
  await expect(installation.ready()).rejects.toBeInstanceOf(RecordedFailure);
  expect(installation.diagnostics.get().error?.snapshot.message).toBe("original setup failure");
  expect(host.diagnostics.get().installations.size).toBe(0);
  expect(host.status).toBe("active");
  await installation.remove();
  await host.stop();
});

it("keeps child readiness and committed membership behind a parent removal transaction", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host = createHost();
  const plugin = definePlugin({
    name: "owned.child",
    setup(ctx) {
      ctx.cleanup(async () => {
        entered.resolve();
        await resume.promise;
      });
    },
  });
  let installation!: Installation<typeof plugin>;
  const child = host.group("child", (group) => {
    installation = group.install(plugin);
  });
  await host.start();
  await child.ready();
  const change = host.change();
  change.remove(installation);
  const commit = change.commit();
  await entered.promise;
  let ready = false;
  const readiness = child.ready().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(child.status).toBe("stopping");
  expect(host.diagnostics.get().installations.get(installation.id)?.status).toBe("stopping");
  resume.resolve();
  await commit;
  await readiness;
  expect(child.status).toBe("active");
  expect(host.diagnostics.get().installations.size).toBe(0);
  await host.stop();
});

it("includes empty descendants in an already-submitted subtree removal", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host = createHost();
  let child!: Group;
  const parent = host.group("parent", (group) => {
    child = group.group("empty", () => undefined);
    group.install(
      definePlugin({
        name: "owned.parent",
        setup(ctx) {
          ctx.cleanup(async () => {
            entered.resolve();
            await resume.promise;
          });
        },
      }),
    );
  });
  await host.start();
  await parent.ready();
  const removal = parent.remove();
  let settled = false;
  const readiness = child.ready().then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await entered.promise;
  expect(settled).toBe(false);
  expect(child.status).toBe("pending");
  resume.resolve();
  await removal;
  expect(await readiness).toMatchObject({ code: "GROUP_REMOVED" });
  await host.stop();
});

it.each([false, true])(
  "reads only committed declarations during rejected validation (eager: %s)",
  async (eager) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const oldService = service<number>("owned/old");
    const nextService = service<number>("owned/next");
    const host = createHost();
    const installation = host.install(
      definePlugin({
        name: "owned.provider",
        provides: { value: oldService },
        setup: () => ({ value: 1 }),
      }),
    );
    await host.start();
    const snapshots: ReturnType<typeof host.diagnostics.get>[] = [];
    const subscription = eager
      ? host.diagnostics.subscribe(() => {
          if (host.status === "changing") snapshots.push(host.diagnostics.get());
        })
      : undefined;
    const change = installation
      .update({
        plugin: definePlugin({
          name: "owned.provider",
          provides: { value: nextService },
          config: {
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
        config: undefined,
      })
      .catch((error: unknown) => error);
    await entered.promise;
    const snapshot = host.diagnostics.get();
    expect(snapshot.installations.get(installation.id)?.provides).toEqual([oldService.id]);
    expect(snapshots.at(-1) ?? snapshot).toBe(snapshot);
    expect(installation.diagnostics.get().provides).toEqual([oldService.id]);
    resume.resolve();
    expect(await change).toMatchObject({ code: "CONFIG_INVALID" });
    expect(host.get(oldService)).toBe(1);
    subscription?.dispose();
    await host.stop();
  },
);

it("captures ContributionStore identity independently of a mutable input token", async () => {
  const original = extensionPoint<number>("owned/items");
  const mutable = { ...original };
  const host = createHost();
  let context!: PluginContext<{}>;
  host.install(
    definePlugin({
      name: "owned.contributor",
      setup(ctx) {
        context = ctx;
      },
    }),
  );
  await host.start();
  const first = context.contribute(mutable, "first", 1);
  mutable.id = "owned/changed";
  first.dispose();
  const second = context.contribute(original, "second", 2);
  expect([...host.contributions(original).get().values()]).toEqual([2]);
  second.dispose();
  await host.stop();
});

it("preserves an independent AbortError when a sibling failure later cancels the layer", async () => {
  const failures = [new Error("independent A"), new DOMException("independent B", "AbortError")];
  const aborted: boolean[] = [];
  const host = createHost();
  failures.forEach((failure, index) =>
    host.install(
      definePlugin({
        name: `owned.failure.${index}`,
        setup(ctx) {
          aborted.push(ctx.signal.aborted);
          throw failure;
        },
      }),
    ),
  );
  await expect(host.start()).rejects.toMatchObject({ errors: failures });
  expect(aborted).toEqual([false, false]);
});

it("reports a synchronous Task failure even when disposal overtakes its report reaction", async () => {
  const failure = new DOMException("independent task", "AbortError");
  const report = vi.fn<(error: unknown) => void>();
  const entered = Promise.withResolvers<void>();
  const host = createHost({ onError: report });
  let task!: Task;
  host.install(
    definePlugin({
      name: "owned.task",
      setup(ctx) {
        task = ctx.spawn((signal) => {
          expect(signal.aborted).toBe(false);
          entered.resolve();
          throw failure;
        });
      },
    }),
  );
  const started = host.start();
  await entered.promise;
  const disposed = task.dispose();
  await expect(task.result).rejects.toBe(failure);
  await disposed;
  await started;
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  await host.stop();
});

it("publishes a terminal Installation snapshot and detaches its observers", async () => {
  const host = createHost();
  const installation = host.install(definePlugin({ name: "owned.snapshot", setup() {} }));
  await host.start();
  const states: string[] = [];
  const subscription = installation.diagnostics.subscribe(() => {
    states.push(installation.diagnostics.get().status);
  });
  await installation.remove();
  expect(states.at(-1)).toBe("removed");
  expect(installation.diagnostics.get()).toMatchObject({ status: "removed" });
  expect(installation.diagnostics.get()).not.toHaveProperty("lifetime");
  expect(() => installation.diagnostics.subscribe(() => undefined)).toThrow("disposed");
  subscription.dispose();
  await host.stop();
});
