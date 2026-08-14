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
  type PluginDefinition,
  type Service,
} from "../src/index";
import { PluginGraph } from "../src/plugin-graph";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function within<T>(promise: Promise<T>, milliseconds = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for concurrent setup")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("application", () => {
  it("validates host ports at the JavaScript trust boundary", () => {
    expect(() => createApp(null as never)).toThrow("options must be an object");
    expect(() => createApp({ logger: {} as never })).toThrow(
      "logger must implement debug/info/warn/error",
    );
  });

  it("owns an immutable snapshot of config validation issues", () => {
    const path = ["settings", { key: "enabled" }] as const;
    const issues = [{ message: "must be enabled", path }];
    const error = new ConfigValidationError(issues);

    (issues[0] as { message: string }).message = "changed";
    (path[1] as { key: string }).key = "changed";

    expect(error.issues).toEqual([
      { message: "must be enabled", path: ["settings", { key: "enabled" }] },
    ]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
    expect(Object.isFrozen(error.issues[0]!.path)).toBe(true);
    expect(Object.isFrozen(error.issues[0]!.path![1])).toBe(true);
  });

  it("validates JavaScript definitions at every installation boundary", () => {
    const TOKEN = service<string>("test/definition-boundary");
    expect(() =>
      definePlugin({
        name: "test.bad-alias",
        requires: { " token": TOKEN },
        setup() {},
      }),
    ).toThrow("cannot start or end with whitespace");
    expect(() => optional({ kind: "service", id: " invalid" } as Service<unknown>)).toThrow(
      TypeError,
    );

    const app = createApp();
    const invalid = { name: " invalid", setup() {} } as PluginDefinition;
    expect(() => app.install(invalid)).toThrow("cannot start or end with whitespace");
  });

  it("isolates runtime commands from failing diagnostics observers", async () => {
    const logger = {
      debug: vi.fn<(...args: unknown[]) => void>(),
      info: vi.fn<(...args: unknown[]) => void>(),
      warn: vi.fn<(...args: unknown[]) => void>(),
      error: vi.fn<(...args: unknown[]) => void>(),
    };
    const plugin = definePlugin({ name: "test.diagnostics", setup() {} });
    const app = createApp({ logger });
    const subscription = app.diagnostics.subscribe(() => {
      throw new Error("broken observer");
    });

    const handle = app.install(plugin);
    await app.start();

    expect(handle.status).toBe("active");
    expect(logger.error).toHaveBeenCalled();
    subscription.dispose();
    await app.stop();
  });

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

  it("selects multi-instance capabilities through explicit contract identities", async () => {
    interface WorkspaceStore {
      readonly workspace: string;
    }

    const workspaceStore = (workspace: string) =>
      service<WorkspaceStore>(`test/workspaces/${workspace}/store`);
    const alphaStore = workspaceStore("alpha");
    const betaStore = workspaceStore("beta");
    const observed: string[] = [];
    const provider = (name: string, token: Service<WorkspaceStore>, workspace: string) =>
      definePlugin({
        name,
        provides: { store: token },
        setup: () => ({ store: { workspace } }),
      });
    const consumer = (name: string, token: Service<WorkspaceStore>) =>
      definePlugin({
        name,
        requires: { store: token },
        setup(ctx) {
          observed.push(`${ctx.meta.group}:${ctx.store.workspace}`);
        },
      });

    const app = createApp();
    app.group("alpha", (group) => {
      group.install(provider("test.alpha-store", alphaStore, "alpha"));
      group.install(consumer("test.alpha-consumer", alphaStore));
    });
    app.group("beta", (group) => {
      group.install(provider("test.beta-store", betaStore, "beta"));
      group.install(consumer("test.beta-consumer", betaStore));
    });

    await app.start();
    expect(observed).toEqual(["/alpha:alpha", "/beta:beta"]);
    await app.stop();
  });

  it("starts independent providers concurrently and waits before starting their consumers", async () => {
    const LEFT = service<string>("test/concurrent-left");
    const RIGHT = service<string>("test/concurrent-right");
    let entered = 0;
    let bothEntered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let consumerStarted = false;
    const provider = (name: string, token: Service<string>) =>
      definePlugin({
        name,
        provides: { value: token },
        async setup() {
          entered++;
          if (entered === 2) bothEntered();
          await barrier;
          return { value: name };
        },
      });
    const consumer = definePlugin({
      name: "test.concurrent-consumer",
      requires: { left: LEFT, right: RIGHT },
      setup(ctx) {
        expect([ctx.left, ctx.right]).toEqual([
          "test.concurrent-left-provider",
          "test.concurrent-right-provider",
        ]);
        consumerStarted = true;
      },
    });
    const app = createApp();
    app.install(provider("test.concurrent-left-provider", LEFT));
    app.install(provider("test.concurrent-right-provider", RIGHT));
    app.install(consumer);

    const starting = app.start();
    await within(ready);
    expect(consumerStarted).toBe(false);

    release();
    await starting;
    expect(consumerStarted).toBe(true);
    await app.stop();
  });

  it("does not silently cap the width of an independent startup layer", async () => {
    const width = 16;
    let entered = 0;
    let allEntered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp();
    for (let index = 0; index < width; index++) {
      app.install(
        definePlugin({
          name: `test.concurrent-width-${index}`,
          async setup() {
            entered++;
            if (entered === width) allEntered();
            await barrier;
          },
        }),
      );
    }

    const starting = app.start();
    await within(ready, 2_000);
    expect(entered).toBe(width);
    release();
    await starting;
    await app.stop();
  });

  it("cancels and disposes sibling setup when one plugin in a layer fails", async () => {
    let entered = 0;
    let bothEntered!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    let siblingAborted = false;
    let siblingCleaned = false;
    const broken = definePlugin({
      name: "test.concurrent-broken",
      async setup() {
        entered++;
        if (entered === 2) bothEntered();
        await ready;
        throw new Error("concurrent setup failed");
      },
    });
    const sibling = definePlugin({
      name: "test.concurrent-sibling",
      setup(ctx) {
        entered++;
        if (entered === 2) bothEntered();
        ctx.cleanup(() => {
          siblingCleaned = true;
        });
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const app = createApp();
    app.install(broken);
    app.install(sibling);

    await expect(within(app.start())).rejects.toThrow("concurrent setup failed");
    expect(siblingAborted).toBe(true);
    expect(siblingCleaned).toBe(true);
    expect(app.status).toBe("idle");
  });

  it("keeps a prepared layer invisible until every sibling succeeds", async () => {
    const NOTICE = event<void>("test/layer-publication-barrier");
    let emit!: () => Promise<void>;
    let listenerPrepared!: () => void;
    let brokenEntered!: () => void;
    let releaseBroken!: () => void;
    const prepared = new Promise<void>((resolve) => {
      listenerPrepared = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      brokenEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseBroken = resolve;
    });
    const listener = vi.fn<() => void>();
    const emitter = definePlugin({
      name: "test.layer-emitter",
      setup(ctx) {
        emit = () => ctx.emit(NOTICE, undefined);
      },
    });
    const preparedListener = definePlugin({
      name: "test.layer-listener",
      setup(ctx) {
        ctx.on(NOTICE, listener);
        listenerPrepared();
      },
    });
    const broken = definePlugin({
      name: "test.layer-late-failure",
      async setup() {
        brokenEntered();
        await barrier;
        throw new Error("late layer failure");
      },
    });
    const app = createApp();
    app.install(emitter);
    await app.start();

    const change = app.change();
    change.install(preparedListener);
    change.install(broken);
    const committing = change.commit();
    await within(Promise.all([prepared, entered]));

    await emit();
    expect(listener).not.toHaveBeenCalled();
    releaseBroken();
    await expect(committing).rejects.toThrow("late layer failure");
    await emit();
    expect(listener).not.toHaveBeenCalled();
    await app.stop();
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

  it("exposes Service lookup only at the active application boundary", async () => {
    const CLOCK = service<{ readonly version: number }>("test/application-get");
    const clock = definePlugin({
      name: "test.application-get",
      provides: { clock: CLOCK },
      setup: (_ctx, version: number) => ({ clock: { version } }),
    });
    const app = createApp();
    const handle = app.install(clock, 1);

    expect(() => app.get(CLOCK)).toThrow("not active");
    await app.start();
    expect(app.get(CLOCK).version).toBe(1);
    await handle.update({ config: 2 });
    expect(app.get(CLOCK).version).toBe(2);
    await app.stop();
    expect(() => app.get(CLOCK)).toThrow("not active");
  });

  it("reads services from the cached active graph and swaps it only after commit", async () => {
    const VALUE = service<{ readonly version: number }>("test/cached-plan");
    const provider = definePlugin({
      name: "test.cached-plan",
      provides: { value: VALUE },
      setup: (_ctx, version: number) => ({ value: { version } }),
    });
    const build = vi.spyOn(PluginGraph, "build");
    const app = createApp();
    const handle = app.install(provider, 1);
    await app.start();

    const afterStart = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(app.get(VALUE).version).toBe(1);
    expect(build).toHaveBeenCalledTimes(afterStart);

    await handle.update({ config: 2 });
    expect(build).toHaveBeenCalledTimes(afterStart + 1);
    const afterUpdate = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(app.get(VALUE).version).toBe(2);
    expect(build).toHaveBeenCalledTimes(afterUpdate);

    await app.stop();
  });

  it("closes the host service boundary while an active ChangeSet rebuilds runtime", async () => {
    const VALUE = service<{ readonly version: number }>("test/changing-service-boundary");
    let entered!: () => void;
    let release!: () => void;
    const rebuilding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = definePlugin({
      name: "test.changing-service-boundary",
      provides: { value: VALUE },
      async setup(_ctx, version: number) {
        if (version === 2) {
          entered();
          await barrier;
        }
        return { value: { version } };
      },
    });
    const app = createApp();
    const handle = app.install(provider, 1);
    await app.start();

    const update = handle.update({ config: 2 });
    await rebuilding;

    expect(app.status).toBe("changing");
    expect(app.diagnostics.get().status).toBe("changing");
    expect(() => app.get(VALUE)).toThrow("not active");

    release();
    await update;
    expect(app.status).toBe("active");
    expect(app.get(VALUE).version).toBe(2);
    await app.stop();
  });

  it("keeps extensions live without restarting their consumers", async () => {
    const ROUTES = extension<{ path: string }>("test/routes");
    const snapshots: string[][] = [];
    let contribution!: Contribution<{ path: string }>;

    const reader = definePlugin({
      name: "test.reader",
      requires: { routes: ROUTES },
      setup(ctx) {
        const read = () => {
          const routes = ctx.routes.get();
          expect("set" in routes).toBe(false);
          snapshots.push([...routes.values()].map((route) => route.path));
        };
        read();
        ctx.routes.subscribe(read);
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
    let emit!: () => Promise<void>;

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
        emit = () => ctx.emit(PING, 1);
      },
    });

    const app = createApp();
    app.install(listeners);
    app.install(emitter);
    await app.start();

    await expect(emit()).rejects.toMatchObject({ errors: expect.any(Array) });
    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);

    await app.stop();
  });

  it("restores the previous application when an update fails", async () => {
    const WORKER = service<{ readonly failed: boolean }>("test/rollback-worker");
    const starts: boolean[] = [];

    const worker = definePlugin({
      name: "test.worker",
      provides: { worker: WORKER },
      setup(_ctx, config: { fail: boolean }) {
        starts.push(config.fail);
        if (config.fail) throw new Error("update failed");
        return { worker: { failed: config.fail } };
      },
    });

    const app = createApp();
    const handle = app.install(worker, { fail: false });
    await app.start();

    await expect(handle.update({ config: { fail: true } })).rejects.toThrow("update failed");

    expect(handle.status).toBe("active");
    expect(app.get(WORKER)).toEqual({ failed: false });
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
      "unrelated:start",
      "middle:start:1",
      "leaf:start:1",
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

  it("rejects new Context work after disposal starts", async () => {
    const CLOSED = event<string>("test/cleanup-event");
    let failure: unknown;
    const plugin = definePlugin({
      name: "test.cleanup-boundary",
      setup(ctx) {
        ctx.cleanup(() => {
          try {
            void ctx.emit(CLOSED, "too-late");
          } catch (error) {
            failure = error;
          }
        });
      },
    });

    const app = createApp();
    app.install(plugin);
    await app.start();
    await app.stop();
    expect(failure).toBeInstanceOf(TypeError);
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

    expect(trace).toEqual(["task:start", "task:abort", "child:stop", "parent:cleanup"]);
  });

  it("migrates provider and consumer contracts in one canonical ChangeSet", async () => {
    const OLD_ENGINE = service<{ version: string }>("test/old-engine");
    const NEW_ENGINE = service<{ version: string }>("test/new-engine");
    const observed: string[] = [];

    const providerV1 = definePlugin({
      name: "test.engine-provider",
      provides: { engine: OLD_ENGINE },
      setup: () => ({ engine: { version: "v1" } }),
    });
    const providerV2 = definePlugin({
      name: "test.engine-provider",
      provides: { engine: NEW_ENGINE },
      setup: () => ({ engine: { version: "v2" } }),
    });
    const consumerV1 = definePlugin({
      name: "test.engine-consumer",
      requires: { engine: OLD_ENGINE },
      setup(ctx) {
        observed.push(ctx.engine.version);
      },
    });
    const consumerV2 = definePlugin({
      name: "test.engine-consumer",
      requires: { engine: NEW_ENGINE },
      setup(ctx) {
        observed.push(ctx.engine.version);
      },
    });

    const app = createApp();
    const provider = app.install(providerV1);
    const consumer = app.install(consumerV1);
    await app.start();

    await expect(provider.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "SERVICE_MISSING",
    });
    expect(provider.status).toBe("active");
    expect(consumer.status).toBe("active");

    const migration = app.change();
    migration.update(provider, { plugin: providerV2 });
    migration.update(consumer, { plugin: consumerV2 });
    await migration.commit();

    expect(observed).toEqual(["v1", "v2"]);
    expect(provider.status).toBe("active");
    expect(consumer.status).toBe("active");

    const removal = app.change();
    removal.remove(provider).remove(consumer);
    await removal.commit();
    expect(provider.status).toBe("removed");
    expect(consumer.status).toBe("removed");
    await expect(provider.remove()).resolves.toBeUndefined();
    await expect(provider.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "PLUGIN_REMOVED",
    });
  });

  it("preserves plugin identity across updates", async () => {
    const original = definePlugin({ name: "test.identity", setup() {} });
    const renamed = definePlugin({ name: "test.renamed", setup() {} });
    const app = createApp();
    const handle = app.install(original);
    await app.start();

    await expect(handle.update({ plugin: renamed })).rejects.toMatchObject({
      code: "PLUGIN_IDENTITY",
    });
    expect(handle.status).toBe("active");

    await app.stop();
  });

  it("makes ChangeSet a one-shot owner of mutation invariants", async () => {
    const plugin = definePlugin({ name: "test.change-owner", setup() {} });
    const first = createApp();
    const second = createApp();
    const handle = first.install(plugin);
    const foreign = second.change();

    expect(() => foreign.remove(handle)).toThrow("different Application");

    const change = first.change();
    expect(() => change.update(handle, {} as never)).toThrow("must include 'plugin' or 'config'");
    change.update(handle, { config: undefined });
    expect(() => change.remove(handle)).toThrow("can only appear once");
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    expect(() => change.install(plugin)).toThrow("committed ChangeSet");
    await committing;
  });

  it("commits an empty ChangeSet without creating a fake runtime transition", async () => {
    const app = createApp();
    await app.start();
    const before = app.diagnostics.get();
    const change = app.change();
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    await committing;

    expect(app.status).toBe("active");
    expect(app.diagnostics.get()).toBe(before);
    await app.stop();
  });

  it("does not grant a draft installation a second mutation path before commit", async () => {
    const received: number[] = [];
    const plugin = definePlugin({
      name: "test.draft-authority",
      setup(_ctx, value: number) {
        received.push(value);
      },
    });
    const app = createApp();
    const change = app.change();
    const handle = change.install(plugin, 1);

    await expect(handle.update({ config: 2 })).rejects.toMatchObject({
      code: "PLUGIN_UNAVAILABLE",
    });
    await expect(handle.remove()).rejects.toMatchObject({ code: "PLUGIN_UNAVAILABLE" });

    const installation = change.commit();
    const update = handle.update({ config: 2 });
    await Promise.all([installation, update]);
    await app.start();
    expect(received).toEqual([2]);
    await app.stop();
  });

  it("freezes context metadata as part of the public read-only boundary", async () => {
    let setupRan = false;
    const plugin = definePlugin({
      name: "test.frozen-meta",
      setup(ctx) {
        setupRan = true;
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.meta)).toBe(true);
        expect(() => {
          (ctx.meta as { name: string }).name = "changed";
        }).toThrow(TypeError);
      },
    });

    const app = createApp();
    app.install(plugin);
    await app.start();
    expect(setupRan).toBe(true);
    await app.stop();
  });

  it("publishes an immutable, composable diagnostics read model", async () => {
    const CLOCK = service<{ now(): number }>("test/diagnostic-clock");
    const provider = definePlugin({
      name: "test.diagnostic-provider",
      provides: { clock: CLOCK },
      setup: () => ({ clock: { now: () => 1 } }),
    });
    const consumer = definePlugin({
      name: "test.diagnostic-consumer",
      requires: { clock: CLOCK },
      setup(ctx) {
        ctx.clock.now();
      },
    });
    const app = createApp({ name: "diagnostic-app" });
    let activeCount = 0;
    const syncCount = () => {
      activeCount = [...app.diagnostics.get().plugins.values()].filter(
        (plugin) => plugin.status === "active",
      ).length;
    };
    syncCount();
    const diagnosticSubscription = app.diagnostics.subscribe(syncCount);

    expect(activeCount).toBe(0);
    app.install(consumer);
    app.install(provider);
    await app.start();

    const snapshot = app.diagnostics.get();
    expect(snapshot.name).toBe("diagnostic-app");
    expect(snapshot.status).toBe("active");
    expect(snapshot.revision).toBeGreaterThan(0);
    expect([...snapshot.groups.keys()]).toEqual(["/"]);
    expect(activeCount).toBe(2);
    expect("set" in snapshot.plugins).toBe(false);

    const providerSnapshot = [...snapshot.plugins.values()].find(
      (plugin) => plugin.name === "test.diagnostic-provider",
    );
    const consumerSnapshot = [...snapshot.plugins.values()].find(
      (plugin) => plugin.name === "test.diagnostic-consumer",
    );
    expect(providerSnapshot?.provides).toEqual(["test/diagnostic-clock"]);
    expect(consumerSnapshot?.requires).toEqual(["test/diagnostic-clock"]);
    expect(Object.isFrozen(providerSnapshot?.provides)).toBe(true);

    await app.stop();
    expect(activeCount).toBe(0);
    diagnosticSubscription.dispose();
  });

  it("observes live Lifetime resources without rebuilding Application diagnostics", async () => {
    const ITEMS = extension<string>("test/diagnostic-resources");
    const NOTICE = event<void>("test/diagnostic-resource-notice");
    let completeTask!: () => void;
    let taskResult!: Promise<void>;
    let releaseResources!: () => Promise<void>;
    const plugin = definePlugin({
      name: "test.diagnostic-resources",
      requires: { items: ITEMS },
      setup(ctx) {
        const cleanup = ctx.cleanup(() => undefined);
        const child = ctx.lifetime();
        const task = ctx.spawn(
          () =>
            new Promise<void>((resolve) => {
              completeTask = resolve;
            }),
        );
        const listener = ctx.on(NOTICE, () => undefined);
        const contribution = ctx.contribute(ITEMS, "value", "value");
        const subscription = ctx.items.subscribe(() => undefined);
        taskResult = task.result;
        releaseResources = async () => {
          listener.dispose();
          contribution.dispose();
          subscription.dispose();
          await child.dispose();
          await cleanup.dispose();
        };
      },
    });
    const app = createApp();
    const handle = app.install(plugin);
    await app.start();

    const applicationSnapshot = app.diagnostics.get();
    const lifetime = applicationSnapshot.plugins.get(handle.id)?.lifetime;
    expect(Object.keys(lifetime ?? {}).sort()).toEqual(["get", "subscribe"]);
    expect(Object.isFrozen(lifetime)).toBe(true);
    expect(lifetime?.get()).toEqual({
      phase: "active",
      cleanups: 1,
      tasks: 1,
      listeners: 1,
      contributions: 1,
      extensionViews: 1,
      subscriptions: 1,
      childLifetimes: 1,
    });
    let notifications = 0;
    const subscription = lifetime!.subscribe(() => notifications++);

    await releaseResources();
    completeTask();
    await taskResult;
    expect(lifetime?.get()).toEqual({
      phase: "active",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      extensionViews: 1,
      subscriptions: 0,
      childLifetimes: 0,
    });
    expect(app.diagnostics.get()).toBe(applicationSnapshot);
    expect(notifications).toBeGreaterThan(0);

    await app.stop();
    expect(lifetime?.get()).toEqual({
      phase: "disposed",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      extensionViews: 0,
      subscriptions: 0,
      childLifetimes: 0,
    });
    expect(app.diagnostics.get().plugins.get(handle.id)?.lifetime).toBeUndefined();
    subscription.dispose();
  });

  it("retains structured plugin failures in diagnostics", async () => {
    const failure = new Error("diagnostic failure");
    const plugin = definePlugin({
      name: "test.diagnostic-failure",
      setup() {
        throw failure;
      },
    });
    const app = createApp();
    app.install(plugin);

    await expect(app.start()).rejects.toBe(failure);
    const snapshot = [...app.diagnostics.get().plugins.values()][0];
    expect(snapshot).toMatchObject({
      name: "test.diagnostic-failure",
      status: "failed",
      error: failure,
    });
  });
});
