import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin } from "dougong";
import { createPlatform, MemoryLoader } from "../src";
import { add, deferred, emptyPlugin, fixture, nextTurn, select } from "./fixtures";

describe("Platform lifecycle", () => {
  it("disposes through the standard resource protocol and detaches its views", async () => {
    const { host, platform } = fixture(new Map([["sample", emptyPlugin("sample")]]));
    const registration = await select(platform, "sample", "sample");
    const view = platform.diagnostics;
    await host.start();
    await platform.activate([registration]);
    await platform[Symbol.asyncDispose]();
    expect(view.get().status).toBe("disposed");
    expect(view.get().registrations.size).toBe(0);
    expect(registration.name).toBe("sample");
    expect(registration.status).toBe("removed");
    expect(registration.activeOrigin).toBeUndefined();
    expect(() => registration.selectedArtifact).toThrow(
      expect.objectContaining({ code: "REGISTRATION_UNAVAILABLE" }),
    );
    expect(() =>
      platform.catalog.add({
        revision: "late",
        manifest: { name: "late", version: "1.0.0" },
        reference: "late",
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_UNAVAILABLE" }));
    expect(() => platform.preview([])).toThrow(
      expect.objectContaining({ code: "PLATFORM_UNAVAILABLE" }),
    );
    await expect(platform.activate([])).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("rejects disposal during setup and joins repeated disposal once the handoff ends", async () => {
    const entered = deferred();
    const release = deferred();
    const cleanup = vi.fn<() => void>();
    const plugin = definePlugin({
      name: "sample",
      async setup({ lifetime }) {
        lifetime.defer(cleanup);
        entered.resolve();
        await release.promise;
      },
    });
    const { host, platform } = fixture(new Map([["one", plugin]]));
    const registration = await select(platform, "sample", "one");
    await host.start();
    const activation = platform.activate([registration]);
    await entered.promise;
    await expect(platform[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
    expect(platform.status).toBe("active");
    release.resolve();
    await activation;
    const first = platform[Symbol.asyncDispose]();
    expect(platform[Symbol.asyncDispose]()).toBe(first);
    expect(platform.status).toBe("disposing");
    await expect(platform.select(registration.selectedArtifact)).rejects.toThrow(
      expect.objectContaining({ code: "PLATFORM_UNAVAILABLE" }),
    );
    await first;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(platform.status).toBe("disposed");
    await host.stop();
  });

  it("reports removal while Core is still releasing the committed installation", async () => {
    const entered = deferred();
    const release = deferred();
    const plugin = definePlugin({
      name: "sample",
      setup({ lifetime }) {
        lifetime.defer(async () => {
          entered.resolve();
          await release.promise;
        });
      },
    });
    const { host, platform } = fixture(new Map([["one", plugin]]));
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    const removing = platform.remove(registration);
    await entered.promise;
    expect(registration.status).toBe("removing");
    expect(platform.diagnostics.get().registrations.get("sample")?.status).toBe("removing");
    release.resolve();
    await removing;
    expect(registration.status).toBe("removed");
    expect(registration.name).toBe("sample");
    expect(registration.error).toBeUndefined();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("abandons a cancelled Loader result without executing its Plugin", async () => {
    const entered = deferred();
    const release = deferred();
    const setup = vi.fn<() => void>();
    const host = createHost();
    const platform = createPlatform({
      id: "late",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load() {
          entered.resolve();
          await release.promise;
          return { default: definePlugin({ name: "sample", setup }) };
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    const result = platform.activate([registration]).catch((error: unknown) => error);
    await entered.promise;
    await platform[Symbol.asyncDispose]();
    expect(await result).toBeInstanceOf(Error);
    release.resolve();
    await nextTurn();
    expect(setup).not.toHaveBeenCalled();
    expect(host.installation(registration.id)).toBeUndefined();
  });

  it("retains ownership when Core rejects removal", async () => {
    const SERVICE = definePlugin({
      name: "sample",
      setup({ lifetime }) {
        lifetime.defer(() => {
          throw new Error("release failed");
        });
      },
    });
    const { host, platform } = fixture(new Map([["one", SERVICE]]));
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    await expect(platform[Symbol.asyncDispose]()).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
    });
    expect(platform.status).toBe("active");
    expect(host.status).toBe("quarantined");
    expect(registration.status).toBe("quarantined");
    expect(registration.selectedArtifact.manifest.name).toBe("sample");
  });

  it("refuses to remove a dependency that an installed artifact still requires", async () => {
    const { platform } = fixture(
      new Map([
        ["dependency", emptyPlugin("dependency")],
        ["root", emptyPlugin("root")],
      ]),
    );
    const dependency = await select(platform, "dependency", "dependency");
    const root = await select(platform, "root", "root", { dependencies: { dependency: "*" } });
    await platform.activate([root]);
    await expect(platform.remove(dependency)).rejects.toMatchObject({
      code: "REGISTRATION_DEPENDENCY_INACTIVE",
    });
    expect(dependency.status).toBe("installed");
    await platform.remove(dependency, root);
    expect(dependency.status).toBe("removed");
    expect(root.status).toBe("removed");
    await platform[Symbol.asyncDispose]();
  });

  it("places installations in an explicit Group and checks ownership before loading", async () => {
    const host = createHost({ groups: [{ id: "extensions" }] });
    const group = host.group("extensions")!;
    const load = vi.fn<() => { default: ReturnType<typeof emptyPlugin> }>(() => ({
      default: emptyPlugin("sample"),
    }));
    const platform = createPlatform({
      id: "group",
      host,
      group,
      apiVersion: "1.0.0",
      loader: { load },
    });
    const registration = await select(platform, "sample", "one");
    await platform.activate([registration]);
    expect(registration.installation?.groupId).toBe("extensions");
    const change = host.change();
    change.removeGroup(group);
    await host.apply(await host.plan(change));
    const calls = load.mock.calls.length;
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(load).toHaveBeenCalledTimes(calls);
    await platform.remove(registration);
    await platform[Symbol.asyncDispose]();
  });

  it("rejects an uncommitted or foreign Group at construction", () => {
    const host = createHost();
    const group = host.change().group("pending");
    expect(() =>
      createPlatform({
        id: "group",
        host,
        group,
        apiVersion: "1.0.0",
        loader: new MemoryLoader(new Map()),
      }),
    ).toThrow("committed");
  });

  it("reports observer failures without changing committed results", async () => {
    const logger = {
      debug: vi.fn<() => void>(),
      info: vi.fn<() => void>(),
      warn: vi.fn<() => void>(),
      error: vi.fn<() => void>(),
    };
    const host = createHost();
    const platform = createPlatform({
      id: "observer",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["one", { default: emptyPlugin("sample") }]])),
      logger,
    });
    const registration = await select(platform, "sample", "one");
    platform.diagnostics.subscribe(() => {
      throw new Error("observer failed");
    });
    expect(await platform.activate([registration])).toEqual({
      stateRevision: host.stateRevision,
      affectedInstallations: [registration.installation!.id],
    });
    expect(registration.status).toBe("installed");
    expect(logger.error).toHaveBeenCalled();
    await platform[Symbol.asyncDispose]();
  });

  it("observes rejection from the terminal logger", async () => {
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: vi.fn<() => Promise<never>>(() => Promise.reject(new Error("sink failed"))),
    };
    const platform = createPlatform({
      id: "sink",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
      logger,
    });
    platform.diagnostics.subscribe(() => {
      throw new Error("observer failed");
    });
    await platform[Symbol.asyncDispose]();
    await nextTurn();
    expect(logger.error).toHaveBeenCalled();
  });

  it("captures options instead of following later replacement of the caller's record", async () => {
    const first = createHost();
    const second = createHost();
    const options = {
      id: "capture",
      host: first,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["one", { default: emptyPlugin("sample") }]])),
    };
    const platform = createPlatform(options);
    options.host = second;
    const registration = await select(platform, "sample", "one");
    await platform.activate([registration]);
    expect(first.installation(registration.id)).toBeDefined();
    expect(second.installation(registration.id)).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it.each(["", " event", "event ", null])(
    "validates activation event %j before dispatch",
    async (event) => {
      const { platform } = fixture();
      await expect(platform.trigger(event as never)).rejects.toThrow(TypeError);
    },
  );

  it("activates every matching root in one batch", async () => {
    const { host, platform } = fixture(
      new Map([
        ["one", emptyPlugin("one")],
        ["two", emptyPlugin("two")],
        ["other", emptyPlugin("other")],
      ]),
    );
    const one = await select(platform, "one", "one");
    const two = await select(platform, "two", "two");
    const other = await select(platform, "other", "other", { activation: ["other"] });
    const before = host.stateRevision;
    await platform.trigger("startup");
    expect(host.stateRevision).toBe(before + 1);
    expect(one.status).toBe("installed");
    expect(two.status).toBe("installed");
    expect(other.status).toBe("selected");
    expect(await platform.trigger("missing")).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it("rejects foreign registration handles and malformed options", async () => {
    const one = fixture().platform;
    const two = fixture().platform;
    const registration = await select(one, "sample", "one");
    await expect(two.activate([registration])).rejects.toThrow("different Platform");
    await expect(one.activate([registration], { signal: {} } as never)).rejects.toThrow(
      "AbortSignal",
    );
    await expect(one.activate(null as never)).rejects.toThrow("array");
    expect(() => one.preview(null as never)).toThrow("array");
    expect(() => one.preview([registration], { remove: {} } as never)).toThrow("array");
    const controller = new AbortController();
    controller.abort();
    await expect(one.activate([registration], { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    await one[Symbol.asyncDispose]();
    await two[Symbol.asyncDispose]();
  });

  it.each([
    null,
    { unknown: true },
    { id: "" },
    { host: {} },
    { loader: {} },
    { authorizer: {} },
    { logger: {} },
  ])("validates Platform constructor capabilities", (override) => {
    const options = {
      id: "validation",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    };
    expect(() =>
      createPlatform(override === null ? (null as never) : ({ ...options, ...override } as never)),
    ).toThrow(TypeError);
  });

  it("does not preserve ambiguous legacy registration properties", async () => {
    const { platform } = fixture();
    const registration = await platform.select(add(platform, "sample", "one"));
    expect("manifest" in registration).toBe(false);
    expect("update" in registration).toBe(false);
    expect("activate" in registration).toBe(false);
    expect(Object.isFrozen(registration)).toBe(true);
    await platform[Symbol.asyncDispose]();
  });
});

it.each(["remove", "dispose"] as const)(
  "projects the real %s command while Core releases an Installation",
  async (action) => {
    const holdLoad = deferred();
    const loading = deferred();
    const holdCleanup = deferred();
    const cleaning = deferred();
    const plugin = definePlugin({
      name: "sample",
      setup({ lifetime }) {
        lifetime.defer(() => {
          cleaning.resolve();
          return holdCleanup.promise;
        });
      },
    });
    const host = createHost();
    const platform = createPlatform({
      id: "real-release",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load(reference: string) {
          if (reference === "two") {
            loading.resolve();
            await holdLoad.promise;
          }
          return { default: plugin };
        },
      },
    });
    await host.start();
    const registration = await select(platform, "sample", "one");
    await platform.activate([registration]);
    await platform.select(add(platform, "sample", "two", "2.0.0"));
    const preparing = platform.activate([registration]).catch((error: unknown) => error);
    await loading.promise;
    const closing =
      action === "remove" ? platform.remove(registration) : platform[Symbol.asyncDispose]();
    try {
      await cleaning.promise;
      expect(registration.status).toBe("removing");
      expect(platform.diagnostics.get().registrations.get("sample")?.status).toBe("removing");
    } finally {
      holdCleanup.resolve();
      holdLoad.resolve();
      await closing;
      await preparing;
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it("captures the logger's adopted method and original receiver exactly once", async () => {
  const logs: unknown[] = [];
  let reads = 0;
  const logger = {
    debug() {},
    info() {},
    warn() {},
    get error() {
      reads++;
      return function (this: typeof logger, value: unknown) {
        if (this !== logger) throw new Error("logger receiver changed");
        logs.push(value);
      };
    },
  };
  const platform = createPlatform({
    id: "log",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
    logger,
  });
  Object.defineProperty(logger, "error", {
    value: () => {
      throw new Error("unadopted sink");
    },
  });
  const failure = new Error("observe");
  platform.diagnostics.subscribe(() => {
    throw failure;
  });
  await select(platform, "sample", "one");
  expect(reads).toBe(1);
  expect(logs).toContain(failure);
  await platform[Symbol.asyncDispose]();
});

it("lets an activation policy await disposal without joining its own callback", async () => {
  const host = createHost();
  const completed = deferred();
  const platform = createPlatform({
    id: "policy-disposal",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["one", { default: emptyPlugin("sample") }]])),
    authorizer: {
      async authorize({ operation }) {
        if (operation === "activate") {
          await platform[Symbol.asyncDispose]();
          completed.resolve();
        }
      },
    },
  });
  const registration = await select(platform, "sample", "one");
  await expect(platform.activate([registration])).rejects.toMatchObject({ name: "AbortError" });
  await completed.promise;
  expect(registration.status).toBe("removed");
  expect(host.installation(registration.id)).toBeUndefined();
});
