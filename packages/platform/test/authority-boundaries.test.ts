import { expect, it, vi } from "vitest";
import { createHost, definePlugin } from "dougong";
import {
  createPlatform,
  defineManifest,
  ImportLoader,
  MemoryLoader,
  PermissionSet,
  type Authorizer,
  type Registration,
} from "../src";
import {
  add,
  deferred,
  emptyPlugin,
  fixture,
  nextTurn,
  select,
  VALUE,
  valuePlugin,
} from "./fixtures";

it.each(["preview roots", "preview removals", "activation removals"] as const)(
  "does not expose a mutable RegistrationRecord through caller-owned %s",
  async (path) => {
    const { platform } = fixture();
    const registration = await select(platform, "sample", "one");
    let exposed: unknown;
    const handles = [registration];
    Object.setPrototypeOf(handles, {
      __proto__: Array.prototype,
      map(callback: (value: Registration<string>) => unknown) {
        exposed = callback(registration);
        return [exposed];
      },
    });
    if (path === "preview roots") platform.preview(handles);
    else if (path === "preview removals") platform.preview([], { remove: handles });
    else await platform.activate([], { remove: handles });
    expect(exposed).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  },
);

it("reads only own registration slots, never getters or a supplier's iterator", async () => {
  const { platform } = fixture(new Map([["one", emptyPlugin("sample")]]));
  const registration = await select(platform, "sample", "one");
  const getter = vi.fn<() => Registration<string>>(() => registration);
  const bad = Object.defineProperty([], "0", { enumerable: true, get: getter });
  await expect(platform.activate(bad)).rejects.toThrow(TypeError);
  expect(getter).not.toHaveBeenCalled();
  const handles = [registration];
  Object.setPrototypeOf(handles, {
    __proto__: Array.prototype,
    *[Symbol.iterator]() {},
  });
  await platform.activate(handles);
  expect(registration.status).toBe("installed");
  await platform[Symbol.asyncDispose]();
});

it("binds the selectable command to the Platform that issued it", async () => {
  const { platform } = fixture();
  const choose = platform.select;
  const artifact = add(platform, "sample", "module");
  expect((await choose(artifact)).selectedArtifact).toBe(artifact);
  await platform[Symbol.asyncDispose]();
});

it("reconciles contradictory committed metadata instead of validating dependencies against a fictional reuse", async () => {
  const { host, platform } = fixture(
    new Map([
      ["dep", valuePlugin("dependency", 2)],
      ["root", emptyPlugin("root")],
    ]),
  );
  const dep = await select(platform, "dependency", "dep", { version: "2.0.0" });
  const root = await select(platform, "root", "root", { dependencies: { dependency: "^2.0.0" } });
  await host.start();
  await platform.activate([dep]);
  const change = host.change();
  change.update(dep.installation!, {
    plugin: valuePlugin("native", 1),
    origin: { ...dep.activeOrigin!, manifest: { name: dep.name, version: "1.0.0" } },
  });
  await host.apply(await host.plan(change));
  expect(dep.activeOrigin?.manifest.version).toBe("1.0.0");
  expect(platform.preview([root]).selections[0]?.action).toBe("update");
  await platform.activate([root]);
  expect(dep.activeOrigin?.manifest.version).toBe("2.0.0");
  expect(await host.use(VALUE, (value) => value.value)).toBe(2);
  await platform[Symbol.asyncDispose]();
  await host.stop();
});

it("treats different dependency and trigger orders as the same committed descriptor", async () => {
  const { host, platform } = fixture(
    new Map(["a", "b", "sample"].map((name) => [name, emptyPlugin(name)])),
  );
  for (const name of ["a", "b"]) await select(platform, name, name);
  const sample = await select(platform, "sample", "sample", {
    dependencies: { b: "*", a: "*" },
    activation: ["b", "a"],
  });
  await platform.activate([sample]);
  const change = host.change();
  const origin = sample.activeOrigin!;
  change.update(sample.installation!, {
    plugin: emptyPlugin("sample"),
    origin: {
      ...origin,
      manifest: { ...origin.manifest, dependencies: { a: "*", b: "*" }, activation: ["a", "b"] },
    },
  });
  await host.apply(await host.plan(change));
  expect(platform.preview([sample]).selections.at(-1)?.action).toBe("reuse");
  await platform[Symbol.asyncDispose]();
});

it("rejects a quarantined destination before requesting admission or evaluating a module", async () => {
  const host = createHost({
    installations: [
      {
        id: "x",
        plugin: definePlugin({
          name: "x",
          setup({ lifetime }) {
            lifetime.defer(() => {
              throw new Error("unreleased");
            });
          },
        }),
      },
    ],
  });
  const authorize = vi.fn<() => void>();
  const load = vi.fn<() => unknown>(() => ({ default: emptyPlugin("sample") }));
  const platform = createPlatform({
    id: "destination",
    host,
    apiVersion: "1.0.0",
    loader: { load },
    authorizer: { authorize },
  });
  const registration = await select(platform, "sample", "one");
  await host.start();
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "PLATFORM_UNAVAILABLE",
  });
  expect(authorize).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  await platform.remove(registration);
  expect(platform.registrations()).toEqual([]);
  await platform[Symbol.asyncDispose]();
});

it("rechecks the destination Group after asynchronous admission and before executing the loader", async () => {
  const host = createHost({ groups: [{ id: "delivery" }] });
  const group = host.group("delivery")!;
  const entered = deferred();
  const resume = deferred();
  const load = vi.fn<() => unknown>(() => ({ default: emptyPlugin("sample") }));
  const platform = createPlatform({
    id: "destination",
    host,
    group,
    apiVersion: "1.0.0",
    loader: { load },
    authorizer: {
      async authorize() {
        entered.resolve();
        await resume.promise;
      },
    },
  });
  const registration = await select(platform, "sample", "one");
  const attempt = platform.activate([registration]).catch((error: unknown) => error);
  await entered.promise;
  const change = host.change();
  change.removeGroup(group);
  await host.apply(await host.plan(change));
  resume.resolve();
  expect(await attempt).toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });
  expect(load).not.toHaveBeenCalled();
  await platform[Symbol.asyncDispose]();
});

it("does not publish caller cancellation as a selected artifact failure or erase a prior real failure", async () => {
  const entered = deferred();
  const resume = deferred();
  let first = true;
  const platform = createPlatform({
    id: "retry",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: {
      async load() {
        if (first) {
          first = false;
          throw new Error("invalid module");
        }
        entered.resolve();
        await resume.promise;
        return { default: emptyPlugin("sample") };
      },
    },
  });
  const registration = await select(platform, "sample", "one");
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const original = registration.error;
  const controller = new AbortController();
  const attempt = platform
    .activate([registration], { signal: controller.signal })
    .catch((error: unknown) => error);
  await entered.promise;
  controller.abort("caller retired");
  expect(await attempt).toBe("caller retired");
  expect(registration.error).toBe(original);
  expect(registration.status).toBe("failed");
  resume.resolve();
  await platform.activate([registration]);
  expect(registration.error).toBeUndefined();
  await platform[Symbol.asyncDispose]();
});

it("uses the admitted loader and authorizer callbacks without rereading replaceable accessors", async () => {
  let policyReads = 0;
  let loaderReads = 0;
  const calls: string[] = [];
  const policy: Authorizer = {
    get authorize() {
      if (++policyReads > 1) throw new Error("policy was read twice");
      return function (this: Authorizer, { operation }: Parameters<Authorizer["authorize"]>[0]) {
        expect(this).toBe(policy);
        calls.push(operation);
      };
    },
  };
  const loader = {
    get load() {
      if (++loaderReads > 1) throw new Error("loader was read twice");
      return function (this: unknown) {
        expect(this).toBe(loader);
        return { default: emptyPlugin("sample") };
      };
    },
  };
  const platform = createPlatform({
    id: "callbacks",
    host: createHost(),
    apiVersion: "1.0.0",
    loader,
    authorizer: policy,
  });
  const registration = await select(platform, "sample", "one");
  await platform.activate([registration]);
  expect(calls).toEqual(["load", "activate"]);
  expect(policyReads).toBe(1);
  expect(loaderReads).toBe(1);
  await platform[Symbol.asyncDispose]();
});

it("cannot hide a denied permission by replacing the request array's filter", () => {
  const permissions = ["admin"];
  Object.setPrototypeOf(permissions, { __proto__: Array.prototype, filter: () => [] });
  const manifest = { ...defineManifest({ name: "policy", version: "1.0.0" }), permissions };
  expect(() =>
    new PermissionSet().authorize(
      { artifact: { revision: "r", manifest }, operation: "activate" },
      new AbortController().signal,
    ),
  ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED", denied: ["admin"] }));
});

it("consumes the input module and permission tables using exactly one iterator lookup", () => {
  const signal = new AbortController().signal;
  let grantReads = 0;
  const permissions = new PermissionSet({
    get [Symbol.iterator]() {
      if (++grantReads > 1) throw new Error("permission iterator changed");
      return function* () {
        yield "read";
      };
    },
  });
  permissions.authorize(
    {
      artifact: {
        revision: "r",
        manifest: defineManifest({ name: "policy", version: "1.0.0", permissions: ["read"] }),
      },
      operation: "load",
    },
    signal,
  );
  let tableReads = 0;
  const table = new Map([["ref", "module"]]);
  Object.defineProperty(table, Symbol.iterator, {
    get() {
      if (++tableReads > 1) throw new Error("module iterator changed");
      return Map.prototype[Symbol.iterator];
    },
  });
  expect(new MemoryLoader(table).load("ref", signal)).toBe("module");
});

it.each(["validation", "admission"] as const)(
  "aborting non-cooperative final %s releases the Platform before handing anything to Core",
  async (phase) => {
    const entered = deferred();
    const release = deferred();
    const pause = () => {
      entered.resolve();
      return release.promise;
    };
    const plugin = definePlugin({
      name: "pending",
      config: {
        "~standard": {
          version: 1,
          vendor: "test",
          async validate(value) {
            if (phase === "validation") await pause();
            return { value };
          },
        },
      },
      setup() {},
    });
    const host = createHost();
    const platform = createPlatform({
      id: "preparation",
      host,
      apiVersion: "1.0.0",
      loader: {
        load: (reference: string) => ({
          default: reference === "pending" ? plugin : emptyPlugin(reference),
        }),
      },
      authorizer: {
        authorize({ artifact, operation }) {
          if (
            phase === "admission" &&
            operation === "activate" &&
            artifact.manifest.name === "pending"
          )
            return pause();
          return undefined;
        },
      },
    });
    const pending = await select(platform, "pending", "pending");
    const controller = new AbortController();
    const attempt = platform
      .activate([pending], { signal: controller.signal })
      .catch((error: unknown) => error);
    await entered.promise;
    controller.abort("withdrawn");
    try {
      expect(await Promise.race([attempt, nextTurn().then(() => "stuck")])).toBe("withdrawn");
      const independent = await select(platform, "independent", "independent");
      await platform.activate([independent]);
      expect(pending.status).toBe("selected");
      expect(pending.error).toBeUndefined();
      expect(independent.status).toBe("installed");
    } finally {
      release.reject(new Error("late preparation failed"));
      await attempt;
      await nextTurn();
      expect(host.installation(pending.id)).toBeUndefined();
      await platform[Symbol.asyncDispose]();
    }
  },
);

it("takes cancellation and listener cleanup from the AbortSignal, not synthetic events or replacement methods", async () => {
  const gate = deferred();
  const entered = deferred();
  const platform = createPlatform({
    id: "signals",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: {
      async load(reference: string) {
        entered.resolve();
        await gate.promise;
        return { default: emptyPlugin(reference) };
      },
    },
  });
  const registration = await select(platform, "sample", "sample");
  const signal = new AbortController().signal;
  const detach = vi.fn<() => void>(() => {
    throw new Error("not a cleanup owner");
  });
  Object.defineProperty(signal, "removeEventListener", { value: detach });
  const result = platform.activate([registration], { signal }).catch((error: unknown) => error);
  await entered.promise;
  signal.dispatchEvent(new Event("abort"));
  gate.resolve();
  expect(await result).toMatchObject({ affectedInstallations: [registration.id] });
  expect(detach).not.toHaveBeenCalled();
  expect(registration.status).toBe("installed");
  await platform[Symbol.asyncDispose]();
});

it("retiring the last waiter blocks late module evaluation even if admission replaces its signal properties", async () => {
  const started = deferred();
  const resume = deferred();
  const load = vi.fn<() => unknown>(() => ({ default: emptyPlugin("sample") }));
  let first = true;
  const platform = createPlatform({
    id: "retired-load",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: { load },
    authorizer: {
      async authorize({ operation }, signal) {
        if (operation === "load" && first) {
          first = false;
          Object.defineProperties(signal, {
            aborted: { value: false },
            throwIfAborted: { value: () => undefined },
          });
          started.resolve();
          await resume.promise;
        }
      },
    },
  });
  const registration = await select(platform, "sample", "sample");
  const controller = new AbortController();
  const attempt = platform
    .activate([registration], { signal: controller.signal })
    .catch((error: unknown) => error);
  await started.promise;
  controller.abort("retired");
  expect(await attempt).toBe("retired");
  // Reuse requires a live preparation. The obsolete one must neither hold this request nor enter the Loader.
  const retry = platform.activate([registration]);
  try {
    expect(
      await Promise.race([retry.then(() => "installed"), nextTurn().then(() => "blocked")]),
    ).toBe("installed");
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    resume.resolve();
    await retry;
    await nextTurn();
    await platform[Symbol.asyncDispose]();
  }
  expect(load).toHaveBeenCalledTimes(1);
});

it("rejects a cancelled direct import even if the caller replaced its signal check during evaluation", async () => {
  const controller = new AbortController();
  const result = new ImportLoader().load(
    "data:text/javascript,export default 301",
    controller.signal,
  );
  Object.defineProperty(controller.signal, "throwIfAborted", { value: () => undefined });
  controller.abort("retired import");
  await expect(result).rejects.toBe("retired import");
});

it.each(["load", "activate"] as const)(
  "detaches during %s admission even if an earlier listener intercepts the caller event",
  async (stage) => {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const authorizing = deferred();
    const resume = deferred();
    const load = vi.fn<() => unknown>(() => ({ default: emptyPlugin("sample") }));
    const host = createHost();
    const platform = createPlatform({
      id: "cancellation-boundary",
      host,
      apiVersion: "1.0.0",
      loader: { load },
      authorizer: {
        async authorize({ operation }) {
          if (operation === stage) {
            authorizing.resolve();
            await resume.promise;
          }
        },
      },
    });
    const registration = await select(platform, "sample", "module");
    const request = platform.activate([registration], { signal: controller.signal });
    await authorizing.promise;
    controller.abort("caller left");
    try {
      await expect(Promise.race([request, nextTurn()])).rejects.toBe("caller left");
    } finally {
      resume.resolve();
      await request.catch(() => undefined);
    }
    expect(load).toHaveBeenCalledTimes(stage === "load" ? 0 : 1);
    expect(registration.error).toBeUndefined();
    expect(registration.installation).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  },
);

it("invokes captured admission and load methods even when their bind properties are decorated", async () => {
  const platformOptions = {
    loader: { load: vi.fn<(name: string) => unknown>((name) => ({ default: emptyPlugin(name) })) },
    authorizer: { authorize: vi.fn<Authorizer["authorize"]>() },
  };
  for (const method of [platformOptions.loader.load, platformOptions.authorizer.authorize]) {
    Object.defineProperty(method, "bind", {
      get() {
        throw new Error("adapter binding is not part of the protocol");
      },
    });
  }
  const platform = createPlatform({
    id: "adapters",
    host: createHost(),
    apiVersion: "1.0.0",
    ...platformOptions,
  });
  const record = await select(platform, "sample", "sample");
  await platform.activate([record]);
  expect(platformOptions.authorizer.authorize).toHaveBeenCalledTimes(2);
  expect(platformOptions.loader.load).toHaveBeenCalledOnce();
  await platform[Symbol.asyncDispose]();
});

it("keeps activation admission and its completion paired for a decorated caller signal", async () => {
  const controller = new AbortController();
  let reads = 0;
  Object.defineProperties(controller.signal, {
    aborted: { get: () => ++reads === 1 },
    reason: { value: "forged refusal" },
  });
  const { platform } = fixture(new Map([["sample", emptyPlugin("sample")]]));
  const registration = await select(platform, "sample", "sample");
  const result = await platform
    .activate([registration], { signal: controller.signal })
    .catch((error: unknown) => error);
  const status = registration.status;
  const closed = await Promise.race([
    platform[Symbol.asyncDispose]().then(() => true),
    nextTurn().then(() => false),
  ]);
  expect({ result, status, closed }).toEqual({
    result: expect.objectContaining({ affectedInstallations: [registration.id] }),
    status: "installed",
    closed: true,
  });
});
