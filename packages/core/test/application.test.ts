import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ConfigValidationError,
  createApp,
  definePlugin,
  event,
  extension,
  optional,
  service,
  type Contribution,
} from "../src/index";
import { signal } from "@dougong/reactive";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("application", () => {
  it("starts service providers before consumers and stops them in reverse", async () => {
    const DATABASE = service<{ query(): string }>("test/database");
    const trace: string[] = [];

    const consumer = definePlugin({
      name: "test.consumer",
      requires: { database: DATABASE },
      setup(ctx) {
        trace.push(ctx.database.query());
        ctx.cleanup(() => {
          trace.push("consumer:stop");
        });
      },
    });

    const provider = definePlugin({
      name: "test.provider",
      provides: { database: DATABASE },
      setup(ctx) {
        trace.push("provider:start");
        ctx.cleanup(() => {
          trace.push("provider:stop");
        });
        return {
          database: { query: () => "consumer:start" },
        };
      },
    });

    const app = createApp();
    app.install(consumer);
    app.install(provider);

    await app.start();
    await app.stop();

    expect(trace).toEqual(["provider:start", "consumer:start", "consumer:stop", "provider:stop"]);
  });

  it("resolves optional services without creating a second dependency API", async () => {
    const CACHE = service<{ get(): string }>("test/cache");
    const values: Array<string | undefined> = [];

    const consumer = definePlugin({
      name: "test.optional-consumer",
      requires: { cache: optional(CACHE) },
      setup(ctx) {
        values.push(ctx.cache?.get());
      },
    });

    const app = createApp();
    app.install(consumer);
    await app.start();
    await app.stop();

    expect(values).toEqual([undefined]);
  });

  it("keeps extensions live without restarting their consumers", async () => {
    const ROUTES = extension<{ path: string }>("test/routes");
    const snapshots: string[][] = [];
    let contribution!: Contribution<{ path: string }>;

    const reader = definePlugin({
      name: "test.reader",
      requires: { routes: ROUTES },
      setup(ctx) {
        ctx.observe(ctx.routes, (routes) => {
          expect("set" in routes).toBe(false);
          snapshots.push([...routes.values()].map((route) => route.path));
        });
      },
    });

    const writer = definePlugin({
      name: "test.writer",
      setup(ctx) {
        contribution = ctx.contribute(ROUTES, "home", { path: "/" });
      },
    });

    const app = createApp();
    app.install(reader);
    const writerHandle = app.install(writer);
    await app.start();
    await tick();

    expect(snapshots).toEqual([[], ["/"]]);

    contribution.update({ path: "/home" });
    await tick();
    expect(snapshots.at(-1)).toEqual(["/home"]);

    await writerHandle.remove();
    await tick();
    expect(snapshots.at(-1)).toEqual([]);

    await app.stop();
  });

  it("broadcasts events in parallel and aggregates listener failures", async () => {
    const PING = event<number>("test/ping");
    const first = vi.fn<(payload: number) => Promise<void>>(async () => {
      await tick();
      throw new Error("first");
    });
    const second = vi.fn<(payload: number) => void>(() => {
      throw new Error("second");
    });
    let emitted!: Promise<void>;

    const listeners = definePlugin({
      name: "test.listeners",
      setup(ctx) {
        ctx.on(PING, first);
        ctx.on(PING, second);
      },
    });

    const emitter = definePlugin({
      name: "test.emitter",
      setup(ctx) {
        emitted = ctx.emit(PING, 1);
      },
    });

    const app = createApp();
    app.install(listeners);
    app.install(emitter);
    await app.start();

    await expect(emitted).rejects.toMatchObject({ errors: expect.any(Array) });
    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);

    await app.stop();
  });

  it("restores the previous application when an update fails", async () => {
    const starts: boolean[] = [];

    const worker = definePlugin({
      name: "test.worker",
      setup(_ctx, config: { fail: boolean }) {
        starts.push(config.fail);
        if (config.fail) throw new Error("update failed");
      },
    });

    const app = createApp();
    const handle = app.install(worker, { fail: false });
    await app.start();

    await expect(handle.update({ config: { fail: true } })).rejects.toThrow("update failed");

    expect(handle.status).toBe("active");
    expect(starts).toEqual([false, true, false]);

    await app.stop();
  });

  it("fails the whole app closed when an affected runtime cannot be cleaned up", async () => {
    let workerStarts = 0;
    let unrelatedStops = 0;

    const worker = definePlugin({
      name: "test.unclean-worker",
      setup(ctx, _version: number) {
        workerStarts++;
        ctx.cleanup(() => {
          throw new Error("resource is still owned");
        });
      },
    });
    const unrelated = definePlugin({
      name: "test.unclean-unrelated",
      setup(ctx) {
        ctx.cleanup(() => {
          unrelatedStops++;
        });
      },
    });

    const app = createApp();
    const workerHandle = app.install(worker, 1);
    const unrelatedHandle = app.install(unrelated);
    await app.start();

    await expect(workerHandle.update({ config: 2 })).rejects.toThrow("could not cleanly stop");

    expect(app.status).toBe("idle");
    expect(workerHandle.status).toBe("pending");
    expect(unrelatedHandle.status).toBe("pending");
    expect(workerStarts).toBe(1);
    expect(unrelatedStops).toBe(1);
  });

  it("restarts only the changed plugin and its transitive dependents", async () => {
    const ROOT = service<{ value: number }>("test/incremental-root");
    const MIDDLE = service<{ value: number }>("test/incremental-middle");
    const trace: string[] = [];

    const root = definePlugin({
      name: "test.incremental-root",
      provides: { root: ROOT },
      setup(ctx, version: number) {
        trace.push(`root:start:${version}`);
        ctx.cleanup(() => {
          trace.push(`root:stop:${version}`);
        });
        return { root: { value: version } };
      },
    });

    const middle = definePlugin({
      name: "test.incremental-middle",
      requires: { root: ROOT },
      provides: { middle: MIDDLE },
      setup(ctx) {
        trace.push(`middle:start:${ctx.root.value}`);
        ctx.cleanup(() => {
          trace.push(`middle:stop:${ctx.root.value}`);
        });
        return { middle: { value: ctx.root.value } };
      },
    });

    const leaf = definePlugin({
      name: "test.incremental-leaf",
      requires: { middle: MIDDLE },
      setup(ctx) {
        trace.push(`leaf:start:${ctx.middle.value}`);
        ctx.cleanup(() => {
          trace.push(`leaf:stop:${ctx.middle.value}`);
        });
      },
    });

    const unrelated = definePlugin({
      name: "test.incremental-unrelated",
      setup(ctx) {
        trace.push("unrelated:start");
        ctx.cleanup(() => {
          trace.push("unrelated:stop");
        });
      },
    });

    const app = createApp();
    const rootHandle = app.install(root, 1);
    app.install(middle);
    app.install(leaf);
    app.install(unrelated);
    await app.start();

    await rootHandle.update({ config: 2 });

    expect(trace).toEqual([
      "root:start:1",
      "middle:start:1",
      "leaf:start:1",
      "unrelated:start",
      "leaf:stop:1",
      "middle:stop:1",
      "root:stop:1",
      "root:start:2",
      "middle:start:2",
      "leaf:start:2",
    ]);

    await app.stop();
    expect(trace.filter((item) => item === "unrelated:start")).toHaveLength(1);
  });

  it("re-resolves optional dependents when a provider appears or disappears", async () => {
    const CACHE = service<{ name: string }>("test/dynamic-cache");
    const values: Array<string | undefined> = [];
    let stops = 0;

    const consumer = definePlugin({
      name: "test.dynamic-optional-consumer",
      requires: { cache: optional(CACHE) },
      setup(ctx) {
        values.push(ctx.cache?.name);
        ctx.cleanup(() => {
          stops++;
        });
      },
    });

    const provider = definePlugin({
      name: "test.dynamic-optional-provider",
      provides: { cache: CACHE },
      setup() {
        return { cache: { name: "memory" } };
      },
    });

    const app = createApp();
    app.install(consumer);
    await app.start();

    const providerHandle = app.install(provider);
    await providerHandle.ready();
    await providerHandle.remove();

    expect(values).toEqual([undefined, "memory", undefined]);
    expect(stops).toBe(2);

    await app.stop();
  });

  it("validates all affected configs before stopping a running instance", async () => {
    const schema: StandardSchemaV1<{ enabled: boolean }, { enabled: boolean }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          if (
            typeof value === "object" &&
            value !== null &&
            (value as { enabled?: unknown }).enabled === true
          ) {
            return { value: { enabled: true } };
          }
          return { issues: [{ message: "enabled must be true" }] };
        },
      },
    };
    let starts = 0;
    let stops = 0;

    const worker = definePlugin({
      name: "test.validated-worker",
      config: schema,
      setup(ctx) {
        starts++;
        ctx.cleanup(() => {
          stops++;
        });
      },
    });

    const app = createApp();
    const handle = app.install(worker, { enabled: true });
    await app.start();

    await expect(handle.update({ config: { enabled: false } })).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect({ starts, stops, status: handle.status }).toEqual({
      starts: 1,
      stops: 0,
      status: "active",
    });

    await app.stop();
  });

  it("separates Standard Schema input from the config received by setup", async () => {
    const schema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          const parsed = typeof value === "string" ? Number(value) : Number.NaN;
          return Number.isFinite(parsed)
            ? { value: parsed }
            : { issues: [{ message: "expected a numeric string" }] };
        },
      },
    };
    const received: number[] = [];
    const parser = definePlugin({
      name: "test.config-transform",
      config: schema,
      setup(_ctx, config) {
        received.push(config);
      },
    });

    const app = createApp();
    const handle = app.install(parser, "21");
    await app.start();
    await handle.update({ config: "42" });

    expect(received).toEqual([21, 42]);
    await app.stop();
  });

  it("requires an explicit new start after startup fails", async () => {
    const VALUE = service<number>("test/recoverable-start");
    let providerStarts = 0;

    const consumer = definePlugin({
      name: "test.recoverable-consumer",
      requires: { value: VALUE },
      setup() {},
    });
    const provider = definePlugin({
      name: "test.recoverable-provider",
      provides: { value: VALUE },
      setup() {
        providerStarts++;
        return { value: 1 };
      },
    });

    const app = createApp();
    app.install(consumer);
    await expect(app.start()).rejects.toMatchObject({ code: "SERVICE_MISSING" });

    const providerHandle = app.install(provider);
    await tick();
    expect(app.status).toBe("idle");
    expect(providerHandle.status).toBe("pending");
    expect(providerStarts).toBe(0);

    await app.start();
    expect(providerStarts).toBe(1);
    await app.stop();
  });

  it("serializes stop followed immediately by an offline update", async () => {
    const trace: string[] = [];
    const worker = definePlugin({
      name: "test.queued-worker",
      setup(ctx, version: number) {
        trace.push(`start:${version}`);
        ctx.cleanup(() => {
          trace.push(`stop:${version}`);
        });
      },
    });

    const app = createApp();
    const handle = app.install(worker, 1);
    await app.start();

    const stopping = app.stop();
    const updating = handle.update({ config: 2 });
    await Promise.all([stopping, updating]);

    expect(trace).toEqual(["start:1", "stop:1"]);
    expect(handle.status).toBe("pending");

    await app.start();
    expect(trace).toEqual(["start:1", "stop:1", "start:2"]);
    await app.stop();
  });

  it("allows asynchronous cleanup to emit while its lifetime is disposing", async () => {
    const CLOSED = event<string>("test/cleanup-event");
    const messages: string[] = [];

    const listener = definePlugin({
      name: "test.cleanup-listener",
      setup(ctx) {
        ctx.on(CLOSED, (message) => {
          messages.push(message);
        });
      },
    });
    const emitter = definePlugin({
      name: "test.cleanup-emitter",
      setup(ctx) {
        ctx.cleanup(async () => {
          await Promise.resolve();
          await ctx.emit(CLOSED, "closed");
        });
      },
    });

    const app = createApp();
    app.install(listener);
    app.install(emitter);
    await app.start();
    await app.stop();

    expect(messages).toEqual(["closed"]);
  });

  it("rejects dependency cycles, duplicate providers, and contract kind collisions", async () => {
    const A = service<string>("test/cycle-a");
    const B = service<string>("test/cycle-b");

    const cyclicApp = createApp();
    cyclicApp.install(
      definePlugin({
        name: "test.cycle-a",
        requires: { b: B },
        provides: { a: A },
        setup: () => ({ a: "a" }),
      }),
    );
    cyclicApp.install(
      definePlugin({
        name: "test.cycle-b",
        requires: { a: A },
        provides: { b: B },
        setup: () => ({ b: "b" }),
      }),
    );
    await expect(cyclicApp.start()).rejects.toMatchObject({ code: "SERVICE_CYCLE" });

    const DUPLICATE = service<number>("test/duplicate");
    const duplicateApp = createApp();
    for (const name of ["first", "second"]) {
      duplicateApp.install(
        definePlugin({
          name: `test.${name}`,
          provides: { value: DUPLICATE },
          setup: () => ({ value: 1 }),
        }),
      );
    }
    await expect(duplicateApp.start()).rejects.toMatchObject({ code: "SERVICE_CONFLICT" });

    const sharedService = service<number>("test/shared-kind");
    const sharedExtension = extension<number>("test/shared-kind");
    const collisionApp = createApp();
    collisionApp.install(
      definePlugin({
        name: "test.kind-provider",
        provides: { value: sharedService },
        setup: () => ({ value: 1 }),
      }),
    );
    collisionApp.install(
      definePlugin({
        name: "test.kind-reader",
        requires: { values: sharedExtension },
        setup() {},
      }),
    );
    await expect(collisionApp.start()).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
  });

  it("cancels spawned work and disposes nested lifetimes", async () => {
    const trace: string[] = [];
    const worker = definePlugin({
      name: "test.structured-lifetime",
      setup(ctx) {
        const child = ctx.lifetime();
        child.cleanup(() => {
          trace.push("child:stop");
        });
        ctx.cleanup(() => {
          trace.push("parent:cleanup");
        });
        ctx.spawn(
          (signal) =>
            new Promise<void>((resolve) => {
              trace.push("task:start");
              signal.addEventListener(
                "abort",
                () => {
                  trace.push("task:abort");
                  resolve();
                },
                { once: true },
              );
            }),
        );
      },
    });

    const app = createApp();
    app.install(worker);
    await app.start();
    await tick();
    await app.stop();

    expect(trace).toEqual(["task:start", "task:abort", "parent:cleanup", "child:stop"]);
  });

  it("replaces observed resources through child lifetimes", async () => {
    const current = signal(1);
    const trace: string[] = [];

    const observer = definePlugin({
      name: "test.observer",
      setup(ctx) {
        ctx.observe(current, (value, lifetime) => {
          trace.push(`start:${value}`);
          lifetime.cleanup(() => {
            trace.push(`stop:${value}`);
          });
        });
      },
    });

    const app = createApp();
    app.install(observer);
    await app.start();

    current.set(2);
    current.set(3);
    await tick();
    await tick();

    expect(trace).toEqual(["start:1", "stop:1", "start:3"]);

    await app.stop();
    expect(trace).toEqual(["start:1", "stop:1", "start:3", "stop:3"]);
  });
});
