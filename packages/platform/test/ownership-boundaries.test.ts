import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  type AnyPlugin,
  type ChangeSet,
  type Installation,
} from "@dougongjs/core";
import { createPlatform, defineManifest, MemoryLoader, PlatformError } from "../src";

it("keeps internally owned manifest declaration failures immutable", () => {
  let failure: unknown;
  try {
    defineManifest({ name: "owned.invalid", version: "1.0.0", dependencies: [] } as never);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(PlatformError);
  expect(Reflect.set(failure as PlatformError, "code", "REGISTRATION_UNAVAILABLE")).toBe(false);
  expect(Object.isFrozen(failure)).toBe(true);
  expect((failure as PlatformError).code).toBe("MANIFEST_INVALID");
});

it("does not grant manifest declaration authority through a copied error constructor", () => {
  let original: unknown;
  try {
    defineManifest({ name: "owned.invalid", version: "1.0.0", dependencies: [] } as never);
  } catch (error) {
    original = error;
  }
  const ErrorClass = (original as Error).constructor as new (
    code: string,
    message: string,
  ) => Error;
  const external = new ErrorClass("MANIFEST_INVALID", "external reflection failed");
  const input = new Proxy(
    { name: "owned.copied-constructor", version: "1.0.0" },
    {
      getPrototypeOf() {
        throw external;
      },
    },
  );
  let failure: unknown;
  try {
    defineManifest(input);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(PlatformError);
  expect(Object.is((failure as Error).cause, external)).toBe(true);
});

it("seals a rejected Registration when authorization throws an inaccessible value", async () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
    authorizer: {
      authorize() {
        throw reason.proxy;
      },
    },
  });
  const change = platform.change();
  const registration = change.register({
    manifest: { name: "owned.inaccessible-authorization", version: "1.0.0" },
    reference: "unused",
  });
  const failure: unknown = await change.commit().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
  expect(registration.status).toBe("failed");
  await expect(registration.ready()).rejects.toMatchObject({
    name: "RecordedFailure",
    code: "REGISTRATION_UNAVAILABLE",
  });
  expect(platform.diagnostics.get().registrations.size).toBe(0);
  await registration.remove();
  await platform.dispose();
});

it("preserves the manifest error boundary when reflection throws an inaccessible value", () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const input = new Proxy(
    { name: "owned.inaccessible-manifest", version: "1.0.0" },
    {
      getPrototypeOf() {
        throw reason.proxy;
      },
    },
  );
  let failure: unknown;
  try {
    defineManifest(input);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code: string }).code).toBe("MANIFEST_INVALID");
  expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
});

it("does not let an external coded error bypass manifest declaration ownership", () => {
  const reason = Proxy.revocable({}, {});
  reason.revoke();
  const external = Object.defineProperty(
    new PlatformError("MANIFEST_INVALID", "external"),
    "code",
    {
      get() {
        throw reason.proxy;
      },
    },
  );
  const input = new Proxy(
    { name: "owned.external-error", version: "1.0.0" },
    {
      getPrototypeOf() {
        throw external;
      },
    },
  );
  let failure: unknown;
  try {
    defineManifest(input);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(PlatformError);
  expect((failure as PlatformError).code).toBe("MANIFEST_INVALID");
  expect(Object.is((failure as Error).cause, external)).toBe(true);
});

it.each([false, true])(
  "derives availability from a removed Core Installation (placeholder: %s)",
  async (placeholder) => {
    const host = createHost();
    const group = host.group("plugins", () => undefined);
    const plugin = definePlugin({ name: "owned.external", setup() {} });
    const load = vi.fn<() => Promise<{ default: AnyPlugin }>>(async () => ({ default: plugin }));
    const platform = createPlatform({ installer: group, apiVersion: "1.0.0", loader: { load } });
    const artifact = {
      manifest: defineManifest({ name: plugin.name, version: "1.0.0" }),
      reference: "v1",
    };
    const registration = await platform.register(
      placeholder ? { ...artifact, placeholder: plugin } : artifact,
    );
    if (!placeholder) await registration.activate();
    await host.start();
    await group.ready();
    const before = platform.diagnostics.get();
    const states: string[] = [];
    const subscription = platform.diagnostics.subscribe(() => {
      const snapshot = platform.diagnostics.get().registrations.get(plugin.name);
      if (snapshot) states.push(snapshot.status);
    });
    await group.remove();
    expect(host.diagnostics.get().installations.size).toBe(0);
    expect(registration.status).toBe("unavailable");
    const after = platform.diagnostics.get();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.registrations.get(plugin.name)?.status).toBe("unavailable");
    expect(states.at(-1)).toBe("unavailable");
    const calls = load.mock.calls.length;
    await expect(registration.activate()).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    await expect(platform.trigger("startup")).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    await expect(registration.ready()).rejects.toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });
    await expect(registration.update({ ...artifact, reference: "v2" })).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(load).toHaveBeenCalledTimes(calls);
    await registration.remove();
    expect(registration.status).toBe("removed");
    subscription.dispose();
    await platform.dispose();
    await host.stop();
  },
);

it("checks installation authority before importing an inactive Artifact", async () => {
  const host = createHost();
  const group = host.group("inactive", () => undefined);
  const load = vi.fn<() => unknown>();
  const platform = createPlatform({ installer: group, apiVersion: "1.0.0", loader: { load } });
  const registration = await platform.register({
    manifest: defineManifest({ name: "owned.inactive", version: "1.0.0" }),
    reference: "inactive",
  });
  await group.remove();
  await expect(registration.activate()).rejects.toMatchObject({ code: "GROUP_REMOVED" });
  expect(load).not.toHaveBeenCalled();
  expect(registration.status).toBe("failed");
  await platform.dispose();
});

it("rejects a live consumer change whose dependency lost its Core Installation", async () => {
  const host = createHost();
  const installations = new Map<string, Pick<Installation, "remove">>();
  const dependencyPlugin = definePlugin({ name: "owned.dependency", setup() {} });
  const consumerPlugin = definePlugin({ name: "owned.consumer", setup() {} });
  const loader = new MemoryLoader(
    new Map([
      ["dep", { default: dependencyPlugin }],
      ["consumer", { default: consumerPlugin }],
    ]),
  );
  const installer = {
    change(): ChangeSet {
      const change = host.change();
      return {
        install(plugin, ...config) {
          const installation = change.install(plugin, ...config);
          installations.set(plugin.name, installation);
          return installation;
        },
        update: change.update.bind(change),
        remove: change.remove.bind(change),
        commit: change.commit.bind(change),
      };
    },
  };
  const platform = createPlatform({ installer, apiVersion: "1.0.0", loader });
  const dependency = await platform.register({
    manifest: defineManifest({ name: dependencyPlugin.name, version: "1.0.0" }),
    reference: "dep",
  });
  const consumerArtifact = {
    manifest: defineManifest({
      name: consumerPlugin.name,
      version: "1.0.0",
      dependencies: { "owned.dependency": "^1.0.0" },
    }),
    reference: "consumer",
  };
  const consumer = await platform.register(consumerArtifact);
  await consumer.activate();
  await host.start();
  await installations.get(dependencyPlugin.name)!.remove();
  expect(dependency.status).toBe("unavailable");
  await expect(consumer.update(consumerArtifact)).rejects.toMatchObject({
    code: "REGISTRATION_DEPENDENCY_INACTIVE",
  });
  await platform.dispose();
  await host.stop();
  expect(dependency.status).toBe("removed");
});

it.each(["1", "1.2", "1.2.x", "*", "01.2.3", " 1.2.3", "1.2.3 "])(
  "rejects non-concrete actual versions: %s",
  (version) => {
    expect(() => defineManifest({ name: "owned.version", version })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
    expect(() =>
      createPlatform({
        installer: createHost(),
        apiVersion: version,
        loader: new MemoryLoader(new Map()),
      }),
    ).toThrow("semantic version");
  },
);

it.each(["0.0.0 || broken", ">0.0.0 broken", "^1.0.0 || >=2.0.0 broken"])(
  "validates every range branch at admission: %s",
  (range) => {
    expect(() =>
      defineManifest({ name: "owned.range", version: "1.0.0", apiVersion: range }),
    ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
    expect(() =>
      defineManifest({ name: "owned.range", version: "1.0.0", dependencies: { dep: range } }),
    ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  },
);

it("rejects unsupported dependency keys instead of dropping declared dependencies", () => {
  const input = JSON.parse(
    '{"name":"owned.consumer","version":"1.0.0","dependencies":{"__proto__":"^1.0.0"}}',
  );
  expect(() => defineManifest(input)).toThrow(
    expect.objectContaining({ code: "MANIFEST_INVALID" }),
  );
  expect(
    defineManifest({
      name: "owned.consumer",
      version: "1.0.0",
      dependencies: { constructor: "^1.0.0", toString: "~1.0.0" },
    }).dependencies,
  ).toEqual({ constructor: "^1.0.0", toString: "~1.0.0" });
});

it("uses concrete versions and npm prerelease range semantics", async () => {
  const plugin = definePlugin({ name: "owned.semver", setup() {} });
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.2.3-beta.1",
    loader: new MemoryLoader(new Map([["plugin", { default: plugin }]])),
  });
  await expect(
    platform.register({
      manifest: defineManifest({ name: plugin.name, version: "1.0.0", apiVersion: "*" }),
      reference: "plugin",
    }),
  ).rejects.toMatchObject({ code: "API_INCOMPATIBLE" });
  const registration = await platform.register({
    manifest: defineManifest({
      name: plugin.name,
      version: "1.0.0",
      apiVersion: ">=1.2.3-beta.0 <2.0.0",
    }),
    reference: "plugin",
  });
  await registration.activate();
  expect(registration.status).toBe("installed");
  await platform.dispose();
});
