import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, type ConfigValue } from "dougong";
import { createPlatform, MemoryLoader } from "../src";
import { add, emptyPlugin, fixture, select, VALUE, valuePlugin } from "./fixtures";

describe("Catalog and selection ownership", () => {
  it("keeps availability, selection and committed origin distinct", async () => {
    const plugin = valuePlugin("sample", 1);
    const { host, platform } = fixture(new Map([["one", plugin]]));
    const artifact = add(platform, "sample", "one");
    expect(platform.catalog.get("sample", "1.0.0")).toBe(artifact);
    expect(platform.diagnostics.get().registrations.size).toBe(0);
    const registration = await platform.select(artifact);
    expect(registration.selectedArtifact).toBe(artifact);
    expect(registration.selectionRevision).toBe(1);
    expect(registration.activeOrigin).toBeUndefined();
    expect(host.installation(registration.id)).toBeUndefined();
    await host.start();
    await platform.activate([registration]);
    expect(registration.status).toBe("installed");
    expect(registration.activeOrigin?.revision).toBe("1.0.0");
    platform.catalog.remove(artifact);
    expect(platform.catalog.get("sample", "1.0.0")).toBeUndefined();
    expect(registration.selectedArtifact).toBe(artifact);
    expect(registration.activeOrigin?.manifest.version).toBe("1.0.0");
    expect(await host.use(VALUE, (value) => value.value)).toBe(1);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not reuse a removed Artifact revision for different bytes", () => {
    const { platform } = fixture();
    const artifact = add(platform, "sample", "one");
    platform.catalog.remove(artifact);
    expect(() => add(platform, "sample", "different")).toThrow(
      expect.objectContaining({ code: "ARTIFACT_DUPLICATE" }),
    );
    expect(platform.catalog.list().size).toBe(0);
  });

  it("rejects foreign and forged Catalog handles", async () => {
    const first = fixture().platform;
    const second = fixture().platform;
    const artifact = add(first, "sample", "one");
    expect(() => second.select(artifact)).toThrow(
      expect.objectContaining({ code: "ARTIFACT_UNAVAILABLE" }),
    );
    expect(() => first.select({ ...artifact })).toThrow(
      expect.objectContaining({ code: "ARTIFACT_UNAVAILABLE" }),
    );
    expect(() => second.catalog.remove(artifact)).toThrow(
      expect.objectContaining({ code: "ARTIFACT_UNAVAILABLE" }),
    );
    await first[Symbol.asyncDispose]();
    await second[Symbol.asyncDispose]();
  });

  it("rejects unowned artifacts without evaluating their properties", async () => {
    const { platform } = fixture();
    const getter = vi.fn<() => never>(() => {
      throw new Error("must not run");
    });
    const forged = {
      get manifest() {
        return getter();
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const artifact of [forged, revoked.proxy, undefined]) {
      expect(() => platform.select(artifact as never)).toThrow(
        expect.objectContaining({ code: "ARTIFACT_UNAVAILABLE" }),
      );
    }
    expect(getter).not.toHaveBeenCalled();
    await platform[Symbol.asyncDispose]();
  });

  it("owns config data before any lazy loading begins", async () => {
    let received: unknown;
    const plugin = definePlugin({
      name: "config",
      config: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
        },
      },
      setup(_context, config) {
        received = config;
      },
    });
    const { host, platform } = fixture(new Map([["config", plugin]]));
    const config = { nested: { count: 1 } };
    const artifact = add(platform, "config", "config", "1.0.0", { config });
    config.nested.count = 8;
    const registration = await platform.select(artifact);
    await host.start();
    await platform.activate([registration]);
    expect(received).toEqual({ nested: { count: 1 } });
    expect(Object.isFrozen(artifact.config)).toBe(true);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it.each([Promise.resolve(1), new Date(), () => 1, new Map()])(
    "rejects config outside the shared data protocol",
    (config) => {
      const { platform } = fixture();
      expect(() => add(platform, "config", "config", "1.0.0", { config })).toThrow(TypeError);
    },
  );

  it("advances only selectionRevision when a new target is chosen", async () => {
    const { host, platform } = fixture();
    const one = add(platform, "sample", "one");
    const two = add(platform, "sample", "two", "2.0.0");
    const registration = await platform.select(one);
    const coreRevision = host.stateRevision;
    expect(await platform.select(one)).toBe(registration);
    expect(registration.selectionRevision).toBe(1);
    expect(await platform.select(two)).toBe(registration);
    expect(registration.selectionRevision).toBe(2);
    expect(registration.selectedArtifact).toBe(two);
    expect(host.stateRevision).toBe(coreRevision);
    await platform[Symbol.asyncDispose]();
  });

  it("does not expose Catalog mutation authority beyond its contract", () => {
    const { platform } = fixture();
    expect(Object.keys(platform.catalog).sort()).toEqual(["add", "get", "list", "remove"]);
    const artifact = add(platform, "sample", "one");
    const snapshot = platform.catalog.list();
    expect("set" in snapshot).toBe(false);
    platform.catalog.remove(artifact);
    expect(snapshot.get("sample")?.get("1.0.0")).toBe(artifact);
  });

  it("keeps manifests compatible with concrete host and prerelease versions", () => {
    const platform = createPlatform({
      id: "prerelease",
      host: createHost(),
      apiVersion: "1.2.3-beta.1",
      loader: new MemoryLoader(new Map()),
    });
    expect(() => add(platform, "sample", "one")).toThrow(
      expect.objectContaining({ code: "API_INCOMPATIBLE" }),
    );
    expect(
      add(platform, "sample", "one", "1.0.0", {
        manifest: { name: "sample", version: "1.0.0", apiVersion: ">=1.2.3-beta.0 <2" },
      }).revision,
    ).toBe("1.0.0");
  });

  it("distinguishes stopped installations from running generations", async () => {
    const { host, platform } = fixture(new Map([["sample", emptyPlugin("sample")]]));
    const registration = await select(platform, "sample", "sample");
    await platform.activate([registration]);
    expect(registration.status).toBe("installed");
    expect(registration.installation?.status).toBe("stopped");
    await host.start();
    expect(registration.installation?.status).toBe("running");
    await host.stop();
    expect(registration.activeOrigin?.revision).toBe("1.0.0");
    await platform[Symbol.asyncDispose]();
  });

  it("does not attribute malformed or foreign Core source metadata to a selected artifact", async () => {
    const { host, platform } = fixture(new Map([["sample", emptyPlugin("sample")]]));
    const registration = await select(platform, "sample", "sample");
    await platform.activate([registration]);
    const origins: ReadonlyArray<Readonly<Record<string, ConfigValue>>> = [
      {
        kind: "artifact",
        platformId: "other",
        revision: "1.0.0",
        manifest: { name: "sample", version: "1.0.0" },
      },
      { kind: "artifact", platformId: "test", revision: 3, manifest: {} },
      {
        kind: "artifact",
        platformId: "test",
        revision: "1.0.0",
        manifest: { name: "sample", version: "invalid" },
      },
    ];
    for (const origin of origins) {
      const change = host.change();
      change.update(registration.installation!, { plugin: emptyPlugin("sample"), origin });
      await host.apply(await host.plan(change));
      expect(registration.activeOrigin).toBeUndefined();
      expect(registration.status).toBe("selected");
      expect(platform.diagnostics.get().registrations.get("sample")?.activeOrigin).toBeUndefined();
    }
    await platform[Symbol.asyncDispose]();
  });

  it.each([undefined, "", " whitespace", "whitespace "])(
    "requires an explicit stable revision %j",
    (revision) => {
      const { platform } = fixture();
      expect(() =>
        platform.catalog.add({
          revision,
          manifest: { name: "sample", version: "1.0.0" },
          reference: "one",
        } as never),
      ).toThrow("revision");
    },
  );

  it("rejects absent references and malformed Artifact records", () => {
    const { platform } = fixture();
    expect(() =>
      platform.catalog.add({
        revision: "one",
        manifest: { name: "sample", version: "1.0.0" },
      } as never),
    ).toThrow("reference");
    expect(() => platform.catalog.add(null as never)).toThrow(TypeError);
    expect(() => add(platform, "sample", "one", "1.0.0", { unknown: true } as never)).toThrow(
      "unknown",
    );
  });
});
