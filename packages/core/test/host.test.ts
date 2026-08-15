import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ConfigValidationError,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  optional,
  service,
  type Contribution,
  type Plugin,
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
    expect(() => createHost(null as never)).toThrow("options must be an object");
    expect(() => createHost({ logger: {} as never })).toThrow(
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

    const host = createHost();
    const invalid = { name: " invalid", setup() {} } as Plugin;
    expect(() => host.install(invalid)).toThrow("cannot start or end with whitespace");
  });

  it("isolates runtime commands from failing diagnostics observers", async () => {
    const logger = {
      debug: vi.fn<(...args: unknown[]) => void>(),
      info: vi.fn<(...args: unknown[]) => void>(),
      warn: vi.fn<(...args: unknown[]) => void>(),
      error: vi.fn<(...args: unknown[]) => void>(),
    };
    const plugin = definePlugin({ name: "test.diagnostics", setup() {} });
    const host = createHost({ logger });
    const subscription = host.diagnostics.subscribe(() => {
      throw new Error("broken observer");
    });

    const handle = host.install(plugin);
    await host.start();

    expect(handle.status).toBe("active");
    expect(logger.error).toHaveBeenCalled();
    subscription.dispose();
    await host.stop();
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

    const host = createHost();
    host.install(consumer);
    host.install(provider);

    await host.start();
    await host.stop();

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
          observed.push(`${ctx.meta.groupId}:${ctx.store.workspace}`);
        },
      });

    const host = createHost();
    host.group("alpha", (group) => {
      group.install(provider("test.alpha-store", alphaStore, "alpha"));
      group.install(consumer("test.alpha-consumer", alphaStore));
    });
    host.group("beta", (group) => {
      group.install(provider("test.beta-store", betaStore, "beta"));
      group.install(consumer("test.beta-consumer", betaStore));
    });

    await host.start();
    expect(observed).toEqual(["/alpha:alpha", "/beta:beta"]);
    await host.stop();
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
    const host = createHost();
    host.install(provider("test.concurrent-left-provider", LEFT));
    host.install(provider("test.concurrent-right-provider", RIGHT));
    host.install(consumer);

    const starting = host.start();
    await within(ready);
    expect(consumerStarted).toBe(false);

    release();
    await starting;
    expect(consumerStarted).toBe(true);
    await host.stop();
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
    const host = createHost();
    for (let index = 0; index < width; index++) {
      host.install(
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

    const starting = host.start();
    await within(ready, 2_000);
    expect(entered).toBe(width);
    release();
    await starting;
    await host.stop();
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
    const host = createHost();
    host.install(broken);
    host.install(sibling);

    await expect(within(host.start())).rejects.toThrow("concurrent setup failed");
    expect(siblingAborted).toBe(true);
    expect(siblingCleaned).toBe(true);
    expect(host.status).toBe("idle");
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
    const host = createHost();
    host.install(emitter);
    await host.start();

    const change = host.change();
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
    await host.stop();
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

    const host = createHost();
    host.install(consumer);
    await host.start();
    await host.stop();

    expect(values).toEqual([undefined]);
  });

  it("exposes Service lookup only at the active application boundary", async () => {
    const CLOCK = service<{ readonly version: number }>("test/application-get");
    const clock = definePlugin({
      name: "test.application-get",
      provides: { clock: CLOCK },
      setup: (_ctx, version: number) => ({ clock: { version } }),
    });
    const host = createHost();
    const handle = host.install(clock, 1);

    expect(() => host.get(CLOCK)).toThrow("not active");
    await host.start();
    expect(host.get(CLOCK).version).toBe(1);
    await handle.update({ config: 2 });
    expect(host.get(CLOCK).version).toBe(2);
    await host.stop();
    expect(() => host.get(CLOCK)).toThrow("not active");
  });

  it("reads services from the cached active graph and swaps it only after commit", async () => {
    const VALUE = service<{ readonly version: number }>("test/cached-plan");
    const provider = definePlugin({
      name: "test.cached-plan",
      provides: { value: VALUE },
      setup: (_ctx, version: number) => ({ value: { version } }),
    });
    const build = vi.spyOn(PluginGraph, "build");
    const host = createHost();
    const handle = host.install(provider, 1);
    await host.start();

    const afterStart = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(host.get(VALUE).version).toBe(1);
    expect(build).toHaveBeenCalledTimes(afterStart);

    await handle.update({ config: 2 });
    expect(build).toHaveBeenCalledTimes(afterStart + 1);
    const afterUpdate = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(host.get(VALUE).version).toBe(2);
    expect(build).toHaveBeenCalledTimes(afterUpdate);

    await host.stop();
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
    const host = createHost();
    const handle = host.install(provider, 1);
    await host.start();

    const update = handle.update({ config: 2 });
    await rebuilding;

    expect(host.status).toBe("changing");
    expect(host.diagnostics.get().status).toBe("changing");
    expect(() => host.get(VALUE)).toThrow("not active");

    release();
    await update;
    expect(host.status).toBe("active");
    expect(host.get(VALUE).version).toBe(2);
    await host.stop();
  });

  it("keeps extensions live without restarting their consumers", async () => {
    const ROUTES = extensionPoint<{ path: string }>("test/routes");
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

    const host = createHost();
    host.install(reader);
    const writerHandle = host.install(writer);
    await host.start();
    await tick();

    expect(snapshots).toEqual([[], ["/"]]);

    contribution.update({ path: "/home" });
    await tick();
    expect(snapshots.at(-1)).toEqual(["/home"]);

    await writerHandle.remove();
    await tick();
    expect(snapshots.at(-1)).toEqual([]);

    await host.stop();
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

    const host = createHost();
    host.install(listeners);
    host.install(emitter);
    await host.start();

    await expect(emit()).rejects.toMatchObject({ errors: expect.any(Array) });
    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);

    await host.stop();
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

    const host = createHost();
    const handle = host.install(worker, { fail: false });
    await host.start();

    await expect(handle.update({ config: { fail: true } })).rejects.toThrow("update failed");

    expect(handle.status).toBe("active");
    expect(host.get(WORKER)).toEqual({ failed: false });
    expect(starts).toEqual([false, true, false]);

    await host.stop();
  });

  it("fails the whole host closed when an affected runtime cannot be cleaned up", async () => {
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

    const host = createHost();
    const workerHandle = host.install(worker, 1);
    const unrelatedHandle = host.install(unrelated);
    await host.start();

    await expect(workerHandle.update({ config: 2 })).rejects.toThrow("could not cleanly stop");

    expect(host.status).toBe("idle");
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

    const host = createHost();
    const rootHandle = host.install(root, 1);
    host.install(middle);
    host.install(leaf);
    host.install(unrelated);
    await host.start();

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

    await host.stop();
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

    const host = createHost();
    host.install(consumer);
    await host.start();

    const providerHandle = host.install(provider);
    await providerHandle.ready();
    await providerHandle.remove();

    expect(values).toEqual([undefined, "memory", undefined]);
    expect(stops).toBe(2);

    await host.stop();
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

    const host = createHost();
    const handle = host.install(worker, { enabled: true });
    await host.start();

    await expect(handle.update({ config: { enabled: false } })).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect({ starts, stops, status: handle.status }).toEqual({
      starts: 1,
      stops: 0,
      status: "active",
    });

    await host.stop();
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

    const host = createHost();
    const handle = host.install(parser, "21");
    await host.start();
    await handle.update({ config: "42" });

    expect(received).toEqual([21, 42]);
    await host.stop();
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

    const host = createHost();
    host.install(consumer);
    await expect(host.start()).rejects.toMatchObject({ code: "SERVICE_MISSING" });

    const providerHandle = host.install(provider);
    await tick();
    expect(host.status).toBe("idle");
    expect(providerHandle.status).toBe("pending");
    expect(providerStarts).toBe(0);

    await host.start();
    expect(providerStarts).toBe(1);
    await host.stop();
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

    const host = createHost();
    const handle = host.install(worker, 1);
    await host.start();

    const stopping = host.stop();
    const updating = handle.update({ config: 2 });
    await Promise.all([stopping, updating]);

    expect(trace).toEqual(["start:1", "stop:1"]);
    expect(handle.status).toBe("pending");

    await host.start();
    expect(trace).toEqual(["start:1", "stop:1", "start:2"]);
    await host.stop();
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

    const host = createHost();
    host.install(plugin);
    await host.start();
    await host.stop();
    expect(failure).toBeInstanceOf(TypeError);
  });

  it("rejects dependency cycles, duplicate providers, and contract kind collisions", async () => {
    const A = service<string>("test/cycle-a");
    const B = service<string>("test/cycle-b");

    const cyclicApp = createHost();
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
    await expect(cyclicApp.start()).rejects.toMatchObject({
      code: "SERVICE_CYCLE",
      message: "Plugin dependency cycle: test.cycle-a:1 -> test.cycle-b:2 -> test.cycle-a:1",
    });

    const DUPLICATE = service<number>("test/duplicate");
    const duplicateApp = createHost();
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
    const sharedExtension = extensionPoint<number>("test/shared-kind");
    const collisionApp = createHost();
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

  it("commits runtime Contract identities only after a successful transaction", async () => {
    const VALUES = extensionPoint<number>("test/transactional-contract-kind");
    const VALUE = service<number>("test/transactional-contract-kind");
    const host = createHost();
    await host.start();

    const failed = host.install(
      definePlugin({
        name: "test.failed-contract-declaration",
        setup(ctx) {
          ctx.contribute(VALUES, "value", 1);
          throw new Error("setup failed");
        },
      }),
    );
    await expect(failed.ready()).rejects.toThrow("setup failed");

    const provider = host.install(
      definePlugin({
        name: "test.recovered-contract-declaration",
        provides: { value: VALUE },
        setup: () => ({ value: 2 }),
      }),
    );
    await provider.ready();

    expect(host.get(VALUE)).toBe(2);
    await host.stop();
  });

  it("does not reserve a Contract identity for an unavailable host read", async () => {
    const VALUE = service<number>("test/unavailable-contract-read");
    const VALUES = extensionPoint<number>("test/unavailable-contract-read");
    const host = createHost();
    await host.start();

    expect(() => host.get(VALUE)).toThrow("is not active");
    const reader = host.install(
      definePlugin({
        name: "test.extension-after-unavailable-read",
        requires: { values: VALUES },
        setup(ctx) {
          expect(ctx.values.get().size).toBe(0);
        },
      }),
    );
    await reader.ready();

    await host.stop();
  });

  it("cancels spawned work and disposes nested lifetimes", async () => {
    const trace: string[] = [];
    const worker = definePlugin({
      name: "test.structured-lifetime",
      setup(ctx) {
        const child = ctx.lifetime("ordered-child");
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

    const host = createHost();
    host.install(worker);
    await host.start();
    await tick();
    await host.stop();

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

    const host = createHost();
    const provider = host.install(providerV1);
    const consumer = host.install(consumerV1);
    await host.start();

    await expect(provider.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "SERVICE_MISSING",
    });
    expect(provider.status).toBe("active");
    expect(consumer.status).toBe("active");

    const migration = host.change();
    migration.update(provider, { plugin: providerV2 });
    migration.update(consumer, { plugin: consumerV2 });
    await migration.commit();

    expect(observed).toEqual(["v1", "v2"]);
    expect(provider.status).toBe("active");
    expect(consumer.status).toBe("active");

    const removal = host.change();
    removal.remove(provider).remove(consumer);
    await removal.commit();
    expect(provider.status).toBe("removed");
    expect(consumer.status).toBe("removed");
    await expect(provider.remove()).resolves.toBeUndefined();
    await expect(provider.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "INSTALLATION_REMOVED",
    });
  });

  it("preserves plugin identity across updates", async () => {
    const original = definePlugin({ name: "test.identity", setup() {} });
    const renamed = definePlugin({ name: "test.renamed", setup() {} });
    const host = createHost();
    const handle = host.install(original);
    await host.start();

    await expect(handle.update({ plugin: renamed })).rejects.toMatchObject({
      code: "INSTALLATION_IDENTITY",
    });
    expect(handle.status).toBe("active");

    await host.stop();
  });

  it("makes ChangeSet a one-shot owner of mutation invariants", async () => {
    const plugin = definePlugin({ name: "test.change-owner", setup() {} });
    const first = createHost();
    const second = createHost();
    const handle = first.install(plugin);
    const foreign = second.change();

    expect(() => foreign.remove(handle)).toThrow("different Host");

    const change = first.change();
    expect(() => change.update(handle, {} as never)).toThrow("must include 'plugin' or 'config'");
    change.update(handle, { config: undefined });
    expect(() => change.remove(handle)).toThrow("can only appear once");
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    expect(() => change.install(plugin)).toThrow("submitted ChangeSet");
    await committing;
  });

  it("commits an empty ChangeSet without creating a fake runtime transition", async () => {
    const host = createHost();
    await host.start();
    const before = host.diagnostics.get();
    const change = host.change();
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    await committing;

    expect(host.status).toBe("active");
    expect(host.diagnostics.get()).toBe(before);
    await host.stop();
  });

  it("does not grant a draft installation a second mutation path before commit", async () => {
    const received: number[] = [];
    const plugin = definePlugin({
      name: "test.draft-authority",
      setup(_ctx, value: number) {
        received.push(value);
      },
    });
    const host = createHost();
    const change = host.change();
    const handle = change.install(plugin, 1);

    await expect(handle.update({ config: 2 })).rejects.toMatchObject({
      code: "INSTALLATION_UNAVAILABLE",
    });
    await expect(handle.remove()).rejects.toMatchObject({ code: "INSTALLATION_UNAVAILABLE" });

    const installation = change.commit();
    const update = handle.update({ config: 2 });
    await Promise.all([installation, update]);
    await host.start();
    expect(received).toEqual([2]);
    await host.stop();
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
          (ctx.meta as { pluginName: string }).pluginName = "changed";
        }).toThrow(TypeError);
      },
    });

    const host = createHost();
    host.install(plugin);
    await host.start();
    expect(setupRan).toBe(true);
    await host.stop();
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
    const host = createHost({ name: "diagnostic-app" });
    let activeCount = 0;
    const syncCount = () => {
      activeCount = [...host.diagnostics.get().installations.values()].filter(
        (plugin) => plugin.status === "active",
      ).length;
    };
    syncCount();
    const diagnosticSubscription = host.diagnostics.subscribe(syncCount);

    expect(activeCount).toBe(0);
    host.install(consumer);
    host.install(provider);
    await host.start();

    const snapshot = host.diagnostics.get();
    expect(snapshot.name).toBe("diagnostic-app");
    expect(snapshot.status).toBe("active");
    expect(snapshot.revision).toBeGreaterThan(0);
    expect([...snapshot.groups.keys()]).toEqual(["/"]);
    expect(activeCount).toBe(2);
    expect("set" in snapshot.installations).toBe(false);

    const providerSnapshot = [...snapshot.installations.values()].find(
      (plugin) => plugin.name === "test.diagnostic-provider",
    );
    const consumerSnapshot = [...snapshot.installations.values()].find(
      (plugin) => plugin.name === "test.diagnostic-consumer",
    );
    expect(providerSnapshot?.provides).toEqual(["test/diagnostic-clock"]);
    expect(consumerSnapshot?.requires).toEqual(["test/diagnostic-clock"]);
    expect(Object.isFrozen(providerSnapshot?.provides)).toBe(true);

    await host.stop();
    expect(activeCount).toBe(0);
    diagnosticSubscription.dispose();
  });

  it("observes live Lifetime resources without rebuilding Host diagnostics", async () => {
    const ITEMS = extensionPoint<string>("test/diagnostic-resources");
    const NOTICE = event<void>("test/diagnostic-resource-notice");
    let completeTask!: () => void;
    let taskResult!: Promise<void>;
    let releaseResources!: () => Promise<void>;
    const plugin = definePlugin({
      name: "test.diagnostic-resources",
      requires: { items: ITEMS },
      setup(ctx) {
        const cleanup = ctx.cleanup(() => undefined);
        const child = ctx.lifetime("diagnostic-child");
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
    const host = createHost();
    const handle = host.install(plugin);
    await host.start();

    const hostSnapshot = host.diagnostics.get();
    const lifetime = hostSnapshot.installations.get(handle.id)?.lifetime;
    expect(Object.keys(lifetime ?? {}).sort()).toEqual(["get", "subscribe"]);
    expect(Object.isFrozen(lifetime)).toBe(true);
    expect(lifetime?.get()).toEqual({
      label: handle.id,
      phase: "active",
      cleanups: 1,
      tasks: 1,
      listeners: 1,
      contributions: 1,
      extensionViews: 1,
      subscriptions: 1,
      children: [
        {
          label: "diagnostic-child",
          phase: "active",
          cleanups: 0,
          tasks: 0,
          listeners: 0,
          contributions: 0,
          extensionViews: 0,
          subscriptions: 0,
          children: [],
        },
      ],
    });
    expect(Object.isFrozen(lifetime?.get().children)).toBe(true);
    expect(Object.isFrozen(lifetime?.get().children[0])).toBe(true);
    let notifications = 0;
    const subscription = lifetime!.subscribe(() => notifications++);

    await releaseResources();
    completeTask();
    await taskResult;
    expect(lifetime?.get()).toEqual({
      label: handle.id,
      phase: "active",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      extensionViews: 1,
      subscriptions: 0,
      children: [],
    });
    expect(host.diagnostics.get()).toBe(hostSnapshot);
    expect(notifications).toBeGreaterThan(0);

    await host.stop();
    expect(lifetime?.get()).toEqual({
      label: handle.id,
      phase: "disposed",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      extensionViews: 0,
      subscriptions: 0,
      children: [],
    });
    expect(host.diagnostics.get().installations.get(handle.id)?.lifetime).toBeUndefined();
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
    const host = createHost();
    host.install(plugin);

    await expect(host.start()).rejects.toBe(failure);
    const snapshot = [...host.diagnostics.get().installations.values()][0];
    expect(snapshot).toMatchObject({
      name: "test.diagnostic-failure",
      status: "failed",
      error: failure,
    });
  });

  it("classifies non-Error setup failures for stable handles", async () => {
    const failure: unknown = undefined;
    const host = createHost();
    const handle = host.install(
      definePlugin({
        name: "test.non-error-failure",
        setup() {
          throw failure;
        },
      }),
    );

    await host.start().catch(() => undefined);
    const classified = await handle.ready().catch((error: unknown) => error);
    expect(classified).toMatchObject({
      name: "DougongError",
      code: "INSTALLATION_UNAVAILABLE",
      message: `Installation '${handle.id}' failed with a non-Error value`,
    });
    expect(host.diagnostics.get().installations.get(handle.id)?.error).toBe(classified);
    await host.stop();
  });
});
