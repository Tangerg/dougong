import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  type AnyPlugin,
  type ChangeSet,
  type Installation,
} from "@dougongjs/core";
import { createPlatform, defineManifest, MemoryLoader } from "../src";

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
