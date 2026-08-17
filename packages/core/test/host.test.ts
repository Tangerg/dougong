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
  type AnyPlugin,
  type Logger,
  type Plugin,
  type Service,
} from "../src/index";
import { InstallationGraph } from "../src/installation-graph";
import { Lifetime } from "../src/lifetime";

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

describe("Host", () => {
  it("validates Host options at the JavaScript trust boundary", () => {
    expect(createHost().name).toBe("host");
    class HostOptionsClass {
      readonly name = "class-host";
    }
    expect(() => createHost(new HostOptionsClass())).toThrow("Host options must be a plain record");
    expect(() => createHost({ unknown: true } as never)).toThrow(
      "Host options: unknown field 'unknown'",
    );
    expect(() => createHost(null as never)).toThrow("Host options must be a plain record");
    expect(() => createHost({ logger: {} as never })).toThrow(
      "logger must implement debug/info/warn/error",
    );
  });

  it("adds Instance identity to every Context log record", async () => {
    let scopedLogger!: Logger;
    const logger = {
      debug: vi.fn<(message: unknown, ...details: unknown[]) => void>(),
      info: vi.fn<(message: unknown, ...details: unknown[]) => void>(),
      warn: vi.fn<(message: unknown, ...details: unknown[]) => void>(),
      error: vi.fn<(message: unknown, ...details: unknown[]) => void>(),
    };
    const plugin = definePlugin({
      name: "test.scoped-logger",
      setup(ctx) {
        scopedLogger = ctx.log;
        ctx.log.debug("debug");
        ctx.log.info("ready", { port: "audio" });
        ctx.log.warn("warn");
        ctx.log.error("error");
        ctx.cleanup(() => ctx.log.info("cleanup"));
      },
    });
    const host = createHost({ name: "player", logger });
    const installation = host.install(plugin);

    await host.start();

    const meta = {
      hostName: "player",
      pluginName: "test.scoped-logger",
      installationId: installation.id,
      groupId: "/",
    };
    expect(logger.debug).toHaveBeenCalledWith("debug", meta);
    expect(logger.info).toHaveBeenCalledWith("ready", meta, { port: "audio" });
    expect(logger.warn).toHaveBeenCalledWith("warn", meta);
    expect(logger.error).toHaveBeenCalledWith("error", meta);
    await host.stop();
    expect(logger.info).toHaveBeenCalledWith("cleanup", meta);
    expect(() => scopedLogger.info("too late")).toThrowError(
      expect.objectContaining({ code: "LIFETIME_DISPOSED" }),
    );
  });

  it("installs a heterogeneous AnyPlugin collection without casts", async () => {
    const CONFIG = service<string>("test/any-plugin-config");
    const observed: string[] = [];
    const plugins: readonly AnyPlugin[] = [
      definePlugin({
        name: "test.any-plugin-provider",
        provides: { config: CONFIG },
        setup() {
          return { config: "ready" };
        },
      }),
      definePlugin({
        name: "test.any-plugin-consumer",
        requires: { config: CONFIG },
        setup(ctx) {
          observed.push(ctx.config);
        },
      }),
    ];
    const host = createHost();
    for (const plugin of plugins) host.install(plugin);

    await host.start();
    expect(observed).toEqual(["ready"]);
    await host.stop();
  });

  it("replaces a Plugin through an erased Installation without casts", async () => {
    const VALUE = service<string>("test/any-plugin-update");
    const plugin = (value: string) =>
      definePlugin({
        name: "test.any-plugin-update",
        provides: { value: VALUE },
        setup() {
          return { value };
        },
      });
    const plugins: readonly AnyPlugin[] = [plugin("first"), plugin("second")];
    const host = createHost();
    const installation = host.install(plugins[0]!);
    await host.start();
    expect(host.get(VALUE)).toBe("first");

    await installation.update({ plugin: plugins[1]! });
    expect(host.get(VALUE)).toBe("second");
    await host.stop();
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

  it("rejects malformed config validation issues at the public boundary", () => {
    const sparseIssues: unknown[] = [];
    sparseIssues.length = 1;
    const sparsePath: unknown[] = [];
    sparsePath.length = 1;

    expect(() => new ConfigValidationError(null as never)).toThrow(
      "Config validation issues must be an array",
    );
    expect(() => new ConfigValidationError([null] as never)).toThrow(
      "Config validation issue at index 0 must be an object",
    );
    expect(() => new ConfigValidationError(sparseIssues as never)).toThrow(
      "Config validation issue at index 0 must be an object",
    );
    expect(() => new ConfigValidationError([{ message: 1 }] as never)).toThrow(
      "Config validation issue at index 0 message must be a string",
    );
    expect(() => new ConfigValidationError([{ message: "bad", path: "field" }] as never)).toThrow(
      "Config validation issue at index 0 path must be an array",
    );
    expect(
      () => new ConfigValidationError([{ message: "bad", path: [{ key: null }] }] as never),
    ).toThrow("Config validation issue at index 0 path segment 0 must contain a property key");
    expect(
      () => new ConfigValidationError([{ message: "bad", path: sparsePath }] as never),
    ).toThrow("Config validation issue at index 0 path segment 0 must be a property key");
  });

  it("validates JavaScript definitions at every installation boundary", () => {
    const TOKEN = service<string>("test/plugin-boundary");
    class PluginClass {
      readonly name = "test.plugin-class";
      setup() {}
    }
    expect(() => definePlugin(new PluginClass())).toThrow(
      "Plugin declaration must be a plain record",
    );
    expect(() =>
      definePlugin({
        name: "test.unknown-plugin-field",
        setup() {},
        unknown: true,
      } as never),
    ).toThrow("Plugin declaration: unknown field 'unknown'");

    const inheritedSetup = Object.getOwnPropertyDescriptor(Object.prototype, "setup");
    Object.defineProperty(Object.prototype, "setup", {
      configurable: true,
      value() {},
    });
    try {
      expect(() => definePlugin({ name: "test.inherited-setup" } as never)).toThrow(
        "Plugin 'test.inherited-setup' must define setup()",
      );
    } finally {
      if (inheritedSetup) Object.defineProperty(Object.prototype, "setup", inheritedSetup);
      else delete (Object.prototype as { setup?: unknown }).setup;
    }

    expect(() =>
      definePlugin({
        name: "test.bad-requires",
        requires: 1 as never,
        setup() {},
      }),
    ).toThrow("Plugin 'test.bad-requires' requires must be a plain record");
    expect(() =>
      definePlugin({
        name: "test.bad-provides",
        provides: new Map() as unknown as {},
        setup() {},
      }),
    ).toThrow("Plugin 'test.bad-provides' provides must be a plain record");
    expect(() =>
      definePlugin({
        name: "test.symbol-requirement",
        requires: { [Symbol("hidden")]: TOKEN } as never,
        setup() {},
      }),
    ).toThrow("Plugin 'test.symbol-requirement' requires keys must be enumerable strings");
    const hiddenProvision = Object.defineProperty({}, "hidden", { value: TOKEN });
    expect(() =>
      definePlugin({
        name: "test.hidden-provision",
        provides: hiddenProvision,
        setup() {},
      }),
    ).toThrow("Plugin 'test.hidden-provision' provides keys must be enumerable strings");
    expect(() =>
      definePlugin({
        name: "test.bad-schema",
        config: null as never,
        setup() {},
      }),
    ).toThrow("Plugin 'test.bad-schema' config must implement Standard Schema V1");
    expect(() =>
      definePlugin({
        name: "test.bad-schema-version",
        config: {
          "~standard": { version: 2, vendor: "test", validate: () => ({ value: undefined }) },
        } as never,
        setup() {},
      }),
    ).toThrow("Plugin 'test.bad-schema-version' config must implement Standard Schema V1");
    expect(() =>
      definePlugin({
        name: "test.bad-schema-vendor",
        config: {
          "~standard": { version: 1, vendor: null, validate: () => ({ value: undefined }) },
        } as never,
        setup() {},
      }),
    ).toThrow("Plugin 'test.bad-schema-vendor' config must implement Standard Schema V1");
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
    expect(() =>
      definePlugin({
        name: "test.duplicate-requirement",
        requires: { first: TOKEN, second: service<string>(TOKEN.id) },
        setup() {},
      }),
    ).toThrow(
      "requirement aliases 'first' and 'second' reference the same Service 'test/plugin-boundary'",
    );
    expect(() =>
      definePlugin({
        name: "test.duplicate-provision",
        provides: { first: TOKEN, second: service<string>(TOKEN.id) },
        setup: () => ({ first: "first", second: "second" }),
      }),
    ).toThrow(
      "provision aliases 'first' and 'second' reference the same Service 'test/plugin-boundary'",
    );
    expect(() =>
      definePlugin({
        name: "test.self-dependency",
        requires: { input: TOKEN },
        provides: { output: TOKEN },
        setup: () => ({ output: "value" }),
      }),
    ).toThrow("cannot both require and provide Service 'test/plugin-boundary'");

    const host = createHost();
    const invalid = { name: " invalid", setup() {} } as Plugin;
    expect(() => host.install(invalid)).toThrow("cannot start or end with whitespace");
  });

  it("isolates Host commands from failing diagnostics observers", async () => {
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

    const installation = host.install(plugin);
    await host.start();

    expect(installation.status).toBe("active");
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

  it("does not duplicate a layer failure through cancelled siblings", async () => {
    const failure = new Error("root setup failed");
    let entered = 0;
    let bothEntered!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const host = createHost();
    host.install(
      definePlugin({
        name: "test.layer-root-failure",
        async setup() {
          entered++;
          if (entered === 2) bothEntered();
          await ready;
          throw failure;
        },
      }),
    );
    host.install(
      definePlugin({
        name: "test.layer-cancelled-sibling",
        setup(ctx) {
          entered++;
          if (entered === 2) bothEntered();
          return new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
          });
        },
      }),
    );

    await expect(host.start()).rejects.toBe(failure);
    expect(host.status).toBe("idle");
  });

  it("preserves independent failures from the same startup layer", async () => {
    const firstFailure = new Error("first setup failed");
    const secondFailure = new Error("second setup failed");
    let entered = 0;
    let bothEntered!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const failingPlugin = (name: string, failure: Error) =>
      definePlugin({
        name,
        async setup() {
          entered++;
          if (entered === 2) bothEntered();
          await ready;
          throw failure;
        },
      });
    const host = createHost();
    host.install(failingPlugin("test.layer-first-failure", firstFailure));
    host.install(failingPlugin("test.layer-second-failure", secondFailure));

    const failure = await host.start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstFailure, secondFailure]);
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
        emit = () => ctx.emit(NOTICE);
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

  it("exposes Service lookup only at the active Host boundary", async () => {
    const CLOCK = service<{ readonly version: number }>("test/host-get");
    const MISSING = service<{ readonly version: number }>("test/host-get-missing");
    const clock = definePlugin({
      name: "test.host-get",
      provides: { clock: CLOCK },
      setup: (_ctx, version: number) => ({ clock: { version } }),
    });
    const host = createHost();
    const installation = host.install(clock, 1);

    expect(() => host.get(CLOCK)).toThrow("not active");
    expect(() => host.get(optional(MISSING))).toThrow("not active");
    await host.start();
    expect(host.get(CLOCK).version).toBe(1);
    expect(host.get(optional(CLOCK))?.version).toBe(1);
    expect(host.get(optional(MISSING))).toBeUndefined();
    await installation.update({ config: 2 });
    expect(host.get(CLOCK).version).toBe(2);
    await host.stop();
    expect(() => host.get(CLOCK)).toThrow("not active");
    expect(() => host.get(optional(MISSING))).toThrow("not active");
  });

  it("reads services from the cached active graph and swaps it only after commit", async () => {
    const VALUE = service<{ readonly version: number }>("test/cached-plan");
    const provider = definePlugin({
      name: "test.cached-plan",
      provides: { value: VALUE },
      setup: (_ctx, version: number) => ({ value: { version } }),
    });
    const build = vi.spyOn(InstallationGraph, "build");
    const host = createHost();
    const installation = host.install(provider, 1);
    await host.start();

    const afterStart = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(host.get(VALUE).version).toBe(1);
    expect(build).toHaveBeenCalledTimes(afterStart);

    await installation.update({ config: 2 });
    expect(build).toHaveBeenCalledTimes(afterStart + 1);
    const afterUpdate = build.mock.calls.length;
    for (let index = 0; index < 100; index++) expect(host.get(VALUE).version).toBe(2);
    expect(build).toHaveBeenCalledTimes(afterUpdate);

    await host.stop();
  });

  it("closes the Host Service boundary while a ChangeSet rebuilds instances", async () => {
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
    const installation = host.install(provider, 1);
    await host.start();

    const update = installation.update({ config: 2 });
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

  it("keeps ExtensionPoint contributions live without restarting their consumers", async () => {
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
    const writerInstallation = host.install(writer);
    await host.start();
    await tick();

    expect(snapshots).toEqual([[], ["/"]]);

    contribution.update({ path: "/home" });
    await tick();
    expect(snapshots.at(-1)).toEqual(["/home"]);

    await writerInstallation.remove();
    await tick();
    expect(snapshots.at(-1)).toEqual([]);

    await host.stop();
  });

  it("exposes one Host-owned ExtensionPoint view to graph-external consumers", async () => {
    const COMMANDS = extensionPoint<{ readonly id: string }>("test/external-commands");
    const host = createHost();
    const commands = host.contributions(COMMANDS);
    const snapshots: string[][] = [];
    using subscription = commands.subscribe(() => {
      snapshots.push([...commands.get().values()].map((command) => command.id));
    });
    expect(subscription).toBeDefined();
    host.install(
      definePlugin({
        name: "test.external-command",
        setup(ctx) {
          ctx.contribute(COMMANDS, "play", { id: "play" });
        },
      }),
    );

    expect(commands.get().size).toBe(0);
    await host.start();
    expect([...commands.get().values()]).toEqual([{ id: "play" }]);
    await host.stop();
    expect(commands.get().size).toBe(0);
    await host.start();
    expect([...commands.get().values()]).toEqual([{ id: "play" }]);
    expect(snapshots).toEqual([["play"], [], ["play"]]);
    await host.stop();
  });

  it("makes a graph-external ExtensionPoint identity durable", async () => {
    const POINT = extensionPoint<string>("test/external-contract-identity");
    const conflicting = service<string>("test/external-contract-identity");
    const host = createHost();
    host.contributions(POINT);
    host.install(
      definePlugin({
        name: "test.external-contract-conflict",
        provides: { conflicting },
        setup() {
          return { conflicting: "value" };
        },
      }),
    );

    await expect(host.start()).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
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

  it("treats repeated Event listeners as independent registrations", async () => {
    const NOTICE = event<void>("test/repeated-event-listener");
    const listener = vi.fn<() => void>();
    let first!: { dispose(): void | Promise<void> };
    let second!: { dispose(): void | Promise<void> };
    let emit!: () => Promise<void>;
    const plugin = definePlugin({
      name: "test.repeated-event-listener",
      setup(ctx) {
        first = ctx.on(NOTICE, listener);
        second = ctx.on(NOTICE, listener);
        emit = () => ctx.emit(NOTICE);
      },
    });
    const host = createHost();
    host.install(plugin);
    await host.start();

    await emit();
    expect(listener).toHaveBeenCalledTimes(2);

    await first.dispose();
    await emit();
    expect(listener).toHaveBeenCalledTimes(3);

    await second.dispose();
    await emit();
    expect(listener).toHaveBeenCalledTimes(3);
    await host.stop();
  });

  it("restores the previous Instances when an update fails", async () => {
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
    const installation = host.install(worker, { fail: false });
    await host.start();

    await expect(installation.update({ config: { fail: true } })).rejects.toThrow("update failed");

    expect(installation.status).toBe("active");
    expect(host.get(WORKER)).toEqual({ failed: false });
    expect(starts).toEqual([false, true, false]);

    await host.stop();
  });

  it("fails closed when the previous Instances cannot be restored", async () => {
    const WORKER = service<string>("test/failed-rollback-worker");
    const changeFailure = new Error("replacement failed");
    const rollbackFailure = new Error("previous worker could not restart");
    let previousStarts = 0;
    const previous = definePlugin({
      name: "test.failed-rollback-worker",
      provides: { worker: WORKER },
      setup() {
        previousStarts++;
        if (previousStarts > 1) throw rollbackFailure;
        return { worker: "previous" };
      },
    });
    const replacement = definePlugin({
      name: "test.failed-rollback-worker",
      provides: { worker: WORKER },
      setup() {
        throw changeFailure;
      },
    });

    const host = createHost();
    const installation = host.install(previous);
    await host.start();
    expect(host.get(WORKER)).toBe("previous");

    const failure = await installation.update({ plugin: replacement }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: "Installation change failed and the previous Instances could not be restored",
      errors: [changeFailure, rollbackFailure],
    });
    expect(previousStarts).toBe(2);
    expect(host.status).toBe("idle");
    expect(installation.status).toBe("failed");
    expect(() => host.get(WORKER)).toThrow("Host services are not active");
  });

  it("fails the whole Host closed when affected Instances cannot be cleaned up", async () => {
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
    const workerInstallation = host.install(worker, 1);
    const unrelatedInstallation = host.install(unrelated);
    await host.start();

    await expect(workerInstallation.update({ config: 2 })).rejects.toThrow(
      "could not cleanly stop",
    );

    expect(host.status).toBe("idle");
    expect(workerInstallation.status).toBe("pending");
    expect(unrelatedInstallation.status).toBe("pending");
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
    const rootInstallation = host.install(root, 1);
    host.install(middle);
    host.install(leaf);
    host.install(unrelated);
    await host.start();

    await rootInstallation.update({ config: 2 });

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

    const providerInstallation = host.install(provider);
    await providerInstallation.ready();
    await providerInstallation.remove();

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
    const installation = host.install(worker, { enabled: true });
    await host.start();

    await expect(installation.update({ config: { enabled: false } })).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect({ starts, stops, status: installation.status }).toEqual({
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
    const installation = host.install(parser, "21");
    await host.start();
    await installation.update({ config: "42" });

    expect(received).toEqual([21, 42]);
    await host.stop();
  });

  it("accepts an explicit undefined issues field in a successful Standard Schema result", async () => {
    const schema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: Number(value), issues: undefined }),
      },
    };
    let received: number | undefined;
    const host = createHost();
    host.install(
      definePlugin({
        name: "test.explicit-undefined-issues",
        config: schema,
        setup(_ctx, config) {
          received = config;
        },
      }),
      "42",
    );

    await host.start();
    expect(received).toBe(42);
    await host.stop();
  });

  it("uses only own Standard Schema result fields as success and failure discriminants", async () => {
    const schema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          return Object.assign(
            Object.create({ issues: [{ message: "inherited failure" }] }) as object,
            { value: Number(value) },
          ) as never;
        },
      },
    };
    let received: number | undefined;
    const host = createHost();
    host.install(
      definePlugin({
        name: "test.own-schema-result",
        config: schema,
        setup(_ctx, config) {
          received = config;
        },
      }),
      "42",
    );

    await host.start();
    expect(received).toBe(42);
    await host.stop();
  });

  it("classifies non-Error config validator failures at the command boundary", async () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate() {
          throw undefined;
        },
      },
    };
    const host = createHost();
    const installation = host.install(
      definePlugin({
        name: "test.non-error-validator",
        config: schema,
        setup() {},
      }),
      undefined,
    );

    const commandFailure = await host.start().catch((error: unknown) => error);
    expect(commandFailure).toMatchObject({
      code: "INSTALLATION_UNAVAILABLE",
      message: `Installation '${installation.id}' failed with a non-Error value`,
    });
    const stableFailure = await installation.ready().catch((error: unknown) => error);
    expect(stableFailure).toMatchObject({
      code: "INSTALLATION_UNAVAILABLE",
    });
    expect(stableFailure).toBe(commandFailure);
  });

  it("rejects a malformed Standard Schema result before setup", async () => {
    let setupRan = false;
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({}) as never,
      },
    };
    const host = createHost();
    host.install(
      definePlugin({
        name: "test.malformed-validator-result",
        config: schema,
        setup() {
          setupRan = true;
        },
      }),
      undefined,
    );

    await expect(host.start()).rejects.toThrow(
      "Installation 'test.malformed-validator-result:1' config validator returned neither value nor issues",
    );
    expect(setupRan).toBe(false);

    const malformedIssueSchema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [null] }) as never,
      },
    };
    const malformedIssueHost = createHost();
    malformedIssueHost.install(
      definePlugin({
        name: "test.malformed-validator-issue",
        config: malformedIssueSchema,
        setup() {
          setupRan = true;
        },
      }),
      undefined,
    );

    await expect(malformedIssueHost.start()).rejects.toThrow(
      "Config validation issue at index 0 must be an object",
    );
    expect(setupRan).toBe(false);
  });

  it("preserves TypeError classification after a failed Installation becomes terminal", async () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({}) as never,
      },
    };
    const host = createHost();
    await host.start();
    const installation = host.install(
      definePlugin({
        name: "test.terminal-type-error",
        config: schema,
        setup() {},
      }),
      undefined,
    );

    await expect(installation.ready()).rejects.toBeInstanceOf(TypeError);
    await expect(installation.ready()).rejects.toBeInstanceOf(TypeError);
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

    const providerInstallation = host.install(provider);
    await tick();
    expect(host.status).toBe("idle");
    expect(providerInstallation.status).toBe("pending");
    expect(providerStarts).toBe(0);

    await host.start();
    expect(providerStarts).toBe(1);
    await host.stop();
  });

  it("establishes layer-wide Instance ownership before publishing Lifetimes", async () => {
    const failure = new Error("publication failed");
    const publish = vi.spyOn(Lifetime.prototype, "publish").mockImplementationOnce(() => {
      throw failure;
    });
    const cleaned: string[] = [];
    const host = createHost();
    for (const name of ["first", "second"]) {
      host.install(
        definePlugin({
          name: `test.publication-ownership-${name}`,
          setup(ctx) {
            ctx.cleanup(() => {
              cleaned.push(name);
            });
          },
        }),
      );
    }

    try {
      await expect(host.start()).rejects.toBe(failure);
      expect(cleaned).toEqual(["second", "first"]);
    } finally {
      publish.mockRestore();
    }
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
    const installation = host.install(worker, 1);
    await host.start();

    const stopping = host.stop();
    const updating = installation.update({ config: 2 });
    await Promise.all([stopping, updating]);

    expect(trace).toEqual(["start:1", "stop:1"]);
    expect(installation.status).toBe("pending");

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
        ctx.cleanup(() =>
          ctx.emit(CLOSED, "too-late").catch((error: unknown) => {
            failure = error;
          }),
        );
      },
    });

    const host = createHost();
    host.install(plugin);
    await host.start();
    await host.stop();
    expect(failure).toMatchObject({
      name: "DougongError",
      code: "LIFETIME_DISPOSED",
      message: "Lifetime is disposing or has been disposed",
    });
  });

  it("rejects dependency cycles, duplicate providers, and contract kind collisions", async () => {
    const A = service<string>("test/cycle-a");
    const B = service<string>("test/cycle-b");

    const cyclicHost = createHost();
    cyclicHost.install(
      definePlugin({
        name: "test.cycle-a",
        requires: { b: B },
        provides: { a: A },
        setup: () => ({ a: "a" }),
      }),
    );
    cyclicHost.install(
      definePlugin({
        name: "test.cycle-b",
        requires: { a: A },
        provides: { b: B },
        setup: () => ({ b: "b" }),
      }),
    );
    await expect(cyclicHost.start()).rejects.toMatchObject({
      code: "SERVICE_CYCLE",
      message: "Installation dependency cycle: test.cycle-a:1 -> test.cycle-b:2 -> test.cycle-a:1",
    });

    const DUPLICATE = service<number>("test/duplicate");
    const duplicateHost = createHost();
    for (const name of ["first", "second"]) {
      duplicateHost.install(
        definePlugin({
          name: `test.${name}`,
          provides: { value: DUPLICATE },
          setup: () => ({ value: 1 }),
        }),
      );
    }
    await expect(duplicateHost.start()).rejects.toMatchObject({ code: "SERVICE_CONFLICT" });

    const sharedService = service<number>("test/shared-kind");
    const sharedExtension = extensionPoint<number>("test/shared-kind");
    const collisionHost = createHost();
    collisionHost.install(
      definePlugin({
        name: "test.kind-provider",
        provides: { value: sharedService },
        setup: () => ({ value: 1 }),
      }),
    );
    collisionHost.install(
      definePlugin({
        name: "test.kind-reader",
        requires: { values: sharedExtension },
        setup() {},
      }),
    );
    await expect(collisionHost.start()).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
  });

  it("commits Contract identities only after a successful transaction", async () => {
    const VALUES = extensionPoint<number>("test/transactional-contract-kind");
    const VALUE = service<number>("test/transactional-contract-kind");
    const host = createHost();
    await host.start();

    const failedInstallation = host.install(
      definePlugin({
        name: "test.failed-contract-declaration",
        setup(ctx) {
          ctx.contribute(VALUES, "value", 1);
          throw new Error("setup failed");
        },
      }),
    );
    await expect(failedInstallation.ready()).rejects.toThrow("setup failed");

    const providerInstallation = host.install(
      definePlugin({
        name: "test.recovered-contract-declaration",
        provides: { value: VALUE },
        setup: () => ({ value: 2 }),
      }),
    );
    await providerInstallation.ready();

    expect(host.get(VALUE)).toBe(2);
    await host.stop();
  });

  it("does not reserve a Contract identity for an unavailable host read", async () => {
    const VALUE = service<number>("test/unavailable-contract-read");
    const VALUES = extensionPoint<number>("test/unavailable-contract-read");
    const host = createHost();
    await host.start();

    expect(() => host.get(VALUE)).toThrow("is not active");
    const readerInstallation = host.install(
      definePlugin({
        name: "test.extension-after-unavailable-read",
        requires: { values: VALUES },
        setup(ctx) {
          expect(ctx.values.get().size).toBe(0);
        },
      }),
    );
    await readerInstallation.ready();

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
    const providerInstallation = host.install(providerV1);
    const consumerInstallation = host.install(consumerV1);
    await host.start();

    await expect(providerInstallation.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "SERVICE_MISSING",
    });
    expect(providerInstallation.status).toBe("active");
    expect(consumerInstallation.status).toBe("active");

    const migration = host.change();
    migration.update(providerInstallation, { plugin: providerV2 });
    migration.update(consumerInstallation, { plugin: consumerV2 });
    await migration.commit();

    expect(observed).toEqual(["v1", "v2"]);
    expect(providerInstallation.status).toBe("active");
    expect(consumerInstallation.status).toBe("active");

    const removal = host.change();
    expect(removal.remove(providerInstallation)).toBeUndefined();
    expect(removal.remove(consumerInstallation)).toBeUndefined();
    await removal.commit();
    expect(providerInstallation.status).toBe("removed");
    expect(consumerInstallation.status).toBe("removed");
    await expect(providerInstallation.remove()).resolves.toBeUndefined();
    await expect(providerInstallation.update({ plugin: providerV2 })).rejects.toMatchObject({
      code: "INSTALLATION_REMOVED",
    });
  });

  it("preserves Installation identity across Plugin updates", async () => {
    const original = definePlugin({ name: "test.identity", setup() {} });
    const renamed = definePlugin({ name: "test.renamed", setup() {} });
    const host = createHost();
    const installation = host.install(original);
    await host.start();

    await expect(installation.update({ plugin: renamed })).rejects.toMatchObject({
      code: "INSTALLATION_IDENTITY",
    });
    expect(installation.status).toBe("active");

    await host.stop();
  });

  it("makes ChangeSet a one-shot owner of mutation invariants", async () => {
    const plugin = definePlugin({ name: "test.change-owner", setup() {} });
    const first = createHost();
    const second = createHost();
    const installation = first.install(plugin);
    const foreign = second.change();

    expect(() => foreign.remove(installation)).toThrow("different Host");

    const change = first.change();
    class InstallationUpdateClass {
      readonly config = undefined;
    }
    expect(() => change.update(installation, new InstallationUpdateClass())).toThrow(
      "Installation update must be a plain record",
    );
    expect(() =>
      change.update(installation, { config: undefined, configuration: undefined } as never),
    ).toThrow("Installation update: unknown field 'configuration'");
    expect(() => change.update(installation, {} as never)).toThrow(
      "must include 'plugin' or 'config'",
    );
    expect(change.update(installation, { config: undefined })).toBeUndefined();
    expect(() => change.remove(installation)).toThrow("can only appear once");
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    expect(() => change.install(plugin)).toThrow("submitted ChangeSet");
    await committing;
  });

  it("commits an empty ChangeSet without creating a fake execution transition", async () => {
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
    const installation = change.install(plugin, 1);

    await expect(installation.update({ config: 2 })).rejects.toMatchObject({
      code: "INSTALLATION_UNAVAILABLE",
    });
    await expect(installation.remove()).rejects.toMatchObject({ code: "INSTALLATION_UNAVAILABLE" });

    expect(() => host.change().remove(installation)).toThrowError(
      expect.objectContaining({ code: "INSTALLATION_UNAVAILABLE" }),
    );
    expect(installation.status).toBe("pending");

    const commit = change.commit();
    const update = installation.update({ config: 2 });
    await Promise.all([commit, update]);
    await host.start();
    expect(received).toEqual([2]);
    await host.stop();
  });

  it("rejects terminal Installations before staging a ChangeSet operation", async () => {
    const plugin = definePlugin({ name: "test.terminal-change-target", setup() {} });
    const host = createHost();
    const installation = host.install(plugin);
    await installation.remove();

    expect(() => host.change().remove(installation)).toThrowError(
      expect.objectContaining({ code: "INSTALLATION_REMOVED" }),
    );
    await expect(installation.remove()).resolves.toBeUndefined();
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
      (installation) => installation.pluginName === "test.diagnostic-provider",
    );
    const consumerSnapshot = [...snapshot.installations.values()].find(
      (installation) => installation.pluginName === "test.diagnostic-consumer",
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
    const installation = host.install(plugin);
    await host.start();

    const hostSnapshot = host.diagnostics.get();
    const lifetime = hostSnapshot.installations.get(installation.id)?.lifetime;
    expect(Object.keys(lifetime ?? {}).sort()).toEqual(["get", "subscribe"]);
    expect(Object.isFrozen(lifetime)).toBe(true);
    expect(lifetime?.get()).toEqual({
      label: installation.id,
      phase: "active",
      cleanups: 1,
      tasks: 1,
      listeners: 1,
      contributions: 1,
      contributionViews: 1,
      subscriptions: 1,
      children: [
        {
          label: "diagnostic-child",
          phase: "active",
          cleanups: 0,
          tasks: 0,
          listeners: 0,
          contributions: 0,
          contributionViews: 0,
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
      label: installation.id,
      phase: "active",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      contributionViews: 1,
      subscriptions: 0,
      children: [],
    });
    expect(host.diagnostics.get()).toBe(hostSnapshot);
    expect(notifications).toBeGreaterThan(0);

    await host.stop();
    expect(lifetime?.get()).toEqual({
      label: installation.id,
      phase: "disposed",
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      contributionViews: 0,
      subscriptions: 0,
      children: [],
    });
    expect(host.diagnostics.get().installations.get(installation.id)?.lifetime).toBeUndefined();
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
      pluginName: "test.diagnostic-failure",
      status: "failed",
      error: failure,
    });
  });

  it("classifies non-Error setup failures for stable Installations", async () => {
    const failure: unknown = undefined;
    const host = createHost();
    const installation = host.install(
      definePlugin({
        name: "test.non-error-failure",
        setup() {
          throw failure;
        },
      }),
    );

    const commandFailure = await host.start().catch((error: unknown) => error);
    expect(commandFailure).toMatchObject({
      name: "DougongError",
      code: "INSTALLATION_UNAVAILABLE",
      message: `Installation '${installation.id}' failed with a non-Error value`,
    });
    const classified = await installation.ready().catch((error: unknown) => error);
    expect(classified).toMatchObject({
      name: "DougongError",
      code: "INSTALLATION_UNAVAILABLE",
      message: `Installation '${installation.id}' failed with a non-Error value`,
    });
    expect(classified).toBe(commandFailure);
    expect(host.diagnostics.get().installations.get(installation.id)?.error).toBe(classified);
    await host.stop();
  });
});
