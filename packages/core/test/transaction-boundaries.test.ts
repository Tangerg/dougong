import { expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
  type PluginContext,
} from "../src/index";

it.each([false, true])(
  "preserves cleanup integrity across sibling failures (unclean: %s)",
  async (unclean) => {
    const host = createHost();
    const starts = vi.fn<() => void>();
    const a = host.install(definePlugin({ name: "a", setup: starts }));
    const b = host.install(definePlugin({ name: "b", setup() {} }));
    await host.start();
    const changes = host.change();
    changes.update(a, {
      plugin: definePlugin({
        name: "a",
        setup(ctx) {
          if (unclean)
            ctx.cleanup(() => {
              throw new Error("cleanup failed");
            });
          throw new Error("a failed");
        },
      }),
    });
    changes.update(b, {
      plugin: definePlugin({
        name: "b",
        setup() {
          throw new Error("b failed");
        },
      }),
    });
    await expect(changes.commit()).rejects.toBeInstanceOf(AggregateError);
    expect(host.status).toBe(unclean ? "idle" : "active");
    expect(starts).toHaveBeenCalledTimes(unclean ? 1 : 2);
    await host.stop();
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
  const host = createHost();
  const message = event<string>("message");
  const items = extensionPoint<string>("items");
  let ctx!: PluginContext<{}>;
  const stopped = vi.fn<() => void>();
  const a = host.install(
    definePlugin({
      name: "a",
      setup(context) {
        ctx = context;
        ctx.cleanup(stopped);
      },
    }),
  );
  const b = host.install(definePlugin({ name: "b", config: schema, setup() {} }), true);
  await host.start();
  const changes = host.change();
  changes.remove(a);
  changes.update(b, { config: false });
  const rejected = changes.commit().catch((error: unknown) => error);
  await entered.promise;
  try {
    expect(ctx.signal.aborted).toBe(false);
    const listener = vi.fn<(payload: string) => void>();
    ctx.on(message, listener);
    ctx.contribute(items, "old", "running");
    await ctx.emit(message, "still alive");
    expect(listener).toHaveBeenCalledWith("still alive");
    expect(stopped).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    expect(await rejected).toHaveProperty("message", expect.stringContaining("rejected"));
  }
  expect(host.status).toBe("active");
  expect(a.status).toBe("active");
  expect(host.contributions(items).get().get(`${a.id}/old`)).toBe("running");
  await host.stop();
  await expect(ctx.emit(message, "too late")).rejects.toThrow(
    "Lifetime is disposing or has been disposed",
  );
  expect(() => ctx.on(message, () => {})).toThrow("Lifetime is disposing or has been disposed");
  expect(() => ctx.contribute(items, "late", "no")).toThrow(
    "Lifetime is disposing or has been disposed",
  );
});

it.each(["cleanup", "rollback", "stop"] as const)(
  "settles indirect readiness after %s forces fail-closed, then permits restart",
  async (mode) => {
    const host = createHost();
    const value = service<number>("value");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let failing = false;
    const provider = definePlugin({
      name: "provider",
      provides: { value },
      setup() {
        return { value: 1 };
      },
    });
    const a = host.install(provider);
    const b = host.install(
      definePlugin({
        name: "consumer",
        requires: { value },
        async setup(ctx) {
          const unclean = failing && mode === "cleanup";
          ctx.cleanup(async () => {
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
    );
    const unrelated = host.install(definePlugin({ name: "unrelated", setup() {} }));
    await host.start();
    failing = true;
    const rejected = a.update({ plugin: provider }).catch((error: unknown) => error);
    await entered.promise;
    const readiness = b.ready().catch((error: unknown) => error);
    resume.resolve();
    expect(await rejected).toBeInstanceOf(AggregateError);
    expect(await readiness).toBeInstanceOf(AggregateError);
    expect(host.status).toBe("idle");
    await expect(b.ready()).rejects.toBeInstanceOf(AggregateError);
    await expect(unrelated.ready()).rejects.toBeInstanceOf(AggregateError);
    failing = false;
    await host.start();
    await expect(b.ready()).resolves.toBeUndefined();
    await expect(unrelated.ready()).resolves.toBeUndefined();
    await host.stop();
  },
);

it("retains a new Group's first commit while a queued second change rolls back", async () => {
  const host = createHost();
  await host.start();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const group = host.group("new", (g) =>
    g.install(
      definePlugin({
        name: "first",
        async setup() {
          entered.resolve();
          await resume.promise;
        },
      }),
    ),
  );
  await entered.promise;
  const changes = group.change();
  changes.install(
    definePlugin({
      name: "second",
      setup() {
        throw new Error("second failed");
      },
    }),
  );
  const rejected = changes.commit().catch((error: unknown) => error);
  const ready = group.ready();
  resume.resolve();
  expect(await rejected).toHaveProperty("message", "second failed");
  await expect(ready).resolves.toBeUndefined();
  expect(group.status).toBe("active");
  await host.stop();
});

it.each(["install", "create", "remove"] as const)(
  "parent readiness includes queued child %s",
  async (kind) => {
    const host = createHost();
    const parent = host.group("parent", () => {});
    const child = parent.group("child", () => {});
    await host.start();
    await parent.ready();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const blocker = host.install(
      definePlugin({
        name: "blocker",
        async setup() {
          entered.resolve();
          await resume.promise;
        },
      }),
    );
    await entered.promise;
    const plugin = definePlugin({ name: "dynamic", setup() {} });
    let removal: Promise<void> | undefined;
    if (kind === "install") child.install(plugin);
    else if (kind === "create") child.group("nested", (g) => g.install(plugin));
    else removal = child.remove();
    const settled = vi.fn<() => void>();
    const ready = parent.ready().then(settled);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resume.resolve();
    await blocker.ready();
    await removal;
    await ready;
    expect(parent.status).toBe("active");
    await host.stop();
  },
);

it("settles the failed attempt before a queued start restores the graph", async () => {
  const host = createHost();
  const value = service<number>("queued/value");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const provider = definePlugin({
    name: "provider",
    provides: { value },
    setup() {
      return { value: 1 };
    },
  });
  const a = host.install(provider);
  let attempts = 0;
  const b = host.install(
    definePlugin({
      name: "consumer",
      requires: { value },
      async setup(ctx) {
        if (++attempts !== 2) return;
        ctx.cleanup(() => {
          throw new Error("cleanup failed");
        });
        entered.resolve();
        await resume.promise;
        throw new Error("setup failed");
      },
    }),
  );
  await host.start();
  const changed = a.update({ plugin: provider }).catch((error: unknown) => error);
  await entered.promise;
  const ready = b.ready().catch((error: unknown) => error);
  const restarted = host.start();
  resume.resolve();
  expect(await changed).toBeInstanceOf(AggregateError);
  expect(await ready).toBeInstanceOf(AggregateError);
  await restarted;
  await b.ready();
  expect(host.status).toBe("active");
  expect(attempts).toBe(3);
  await host.stop();
});
