import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, DougongError, extensionPoint, service } from "@dougongjs/core";
import * as platformApi from "../src/index";

const {
  createPlatform,
  defineManifest,
  ImportLoader,
  MemoryLoader,
  PermissionDeniedError,
  PermissionSet,
  PlatformError,
} = platformApi;
type Manifest = platformApi.Manifest;

describe("public API surface", () => {
  it("keeps the Platform value-export budget explicit", () => {
    expect(Object.keys(platformApi).sort()).toEqual([
      "ImportLoader",
      "MemoryLoader",
      "PermissionDeniedError",
      "PermissionSet",
      "PlatformError",
      "createPlatform",
      "defineManifest",
    ]);
  });
});

describe("Platform", () => {
  it("validates constructor ports before creating Platform state", () => {
    expect(() => createPlatform(null as never)).toThrow("options must be an object");
    expect(() =>
      createPlatform({
        installer: createHost(),
        apiVersion: "1.0.0",
        loader: {} as never,
      }),
    ).toThrow("loader must implement load()");
    expect(() =>
      createPlatform({
        installer: createHost(),
        apiVersion: "1.0.0",
        loader: new MemoryLoader(new Map()),
        authorizer: null as never,
      }),
    ).toThrow("authorizer must implement authorize()");
    expect(() =>
      createPlatform({
        installer: createHost(),
        apiVersion: "1.0.0",
        loader: new MemoryLoader(new Map()),
        logger: {} as never,
      }),
    ).toThrow("logger must implement debug/info/warn/error");
  });

  it("keeps Registrations and ChangeSets opaque to JavaScript reflection", async () => {
    const plugin = definePlugin({ name: "opaque.plugin", setup() {} });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["opaque", { default: plugin }]])),
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "opaque.plugin", version: "1.0.0" },
      reference: "opaque",
    });

    expect(Object.keys(change)).toEqual([]);
    expect(Object.keys(registration)).toEqual([]);
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(platform)).toBe(true);
    expect(registration.status).toBe("pending");
    const diagnosticSubscription = platform.diagnostics.subscribe(() => undefined);
    expect("notify" in diagnosticSubscription).toBe(false);
    expect("close" in diagnosticSubscription).toBe(false);
    diagnosticSubscription[Symbol.dispose]?.();
    for (const internal of [
      "createRegistration",
      "attachRegistration",
      "resolve",
      "normalize",
      "execute",
      "activateRegistration",
    ]) {
      expect(internal in platform).toBe(false);
    }
    await expect(registration.activate()).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    await expect(registration.remove()).rejects.toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });
    const unrelatedChange = platform.change().remove(registration);
    await expect(unrelatedChange.commit()).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(registration.status).toBe("pending");
    const before = platform.diagnostics.get();
    await platform.change().commit();
    expect(platform.diagnostics.get()).toBe(before);
    await change.commit();
    await platform.dispose();
  });

  it("revokes uncommitted drafts when the Platform reaches its terminal state", async () => {
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "stale.draft", version: "1.0.0" },
      reference: "missing",
    });
    await platform.dispose();

    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    await expect(committing).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    expect(registration.status).toBe("failed");
    await expect(registration.activate()).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
  });

  it("refuses to grant draft authority after disposal begins", async () => {
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "disposing.draft", version: "1.0.0" },
      reference: "missing",
    });

    const disposing = platform.dispose();
    const committing = change.commit();

    expect(platform.status).toBe("disposing");
    expect(registration.status).toBe("failed");
    await expect(committing).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await disposing;
  });

  it("validates MemoryLoader's module collection boundary", () => {
    expect(() => new MemoryLoader(null as never)).toThrowError(
      new TypeError("MemoryLoader modules must be a ReadonlyMap"),
    );
    expect(() => new MemoryLoader([] as never)).toThrowError(
      new TypeError("MemoryLoader modules must be a ReadonlyMap"),
    );
  });

  it("does not retain Platform ports through a terminal Registration", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createTerminalRegistration();
    const references = Object.values(fixture.references);
    for (let pass = 0; pass < 8 && references.some((ref) => ref.deref()); pass++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      forceGc();
      forceGc();
    }

    expect(fixture.registration.status).toBe("removed");
    expect(
      Object.fromEntries(
        Object.entries(fixture.references).map(([name, ref]) => [name, ref.deref() === undefined]),
      ),
    ).toEqual({ host: true, loader: true, platform: true });
  });

  it("does not retain Platform ports through a historical diagnostic view", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createHistoricalPlatformDiagnostics();
    const references = Object.values(fixture.references);
    for (let pass = 0; pass < 8 && references.some((ref) => ref.deref()); pass++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      forceGc();
      forceGc();
    }

    expect(fixture.diagnostics.get()).toMatchObject({ status: "disposed" });
    expect(() => fixture.subscription.dispose()).not.toThrow();
    expect(
      Object.fromEntries(
        Object.entries(fixture.references).map(([name, ref]) => [name, ref.deref() === undefined]),
      ),
    ).toEqual({ host: true, loader: true, platform: true });
  });

  it("does not retain Platform ports through an abandoned Registration", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createAbandonedRegistration();
    const references = Object.values(fixture.references);
    for (let pass = 0; pass < 8 && references.some((ref) => ref.deref()); pass++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      forceGc();
      forceGc();
    }

    expect(fixture.registration.status).toBe("failed");
    expect(
      Object.fromEntries(
        Object.entries(fixture.references).map(([name, ref]) => [name, ref.deref() === undefined]),
      ),
    ).toEqual({ host: true, loader: true, platform: true });
    await expect(fixture.registration.ready()).rejects.toMatchObject({
      code: "REGISTRATION_DUPLICATE",
    });
  });

  it("preserves Core error identity after a Registration becomes terminal", async () => {
    const missing = service<string>("terminal/core-missing");
    const placeholder = definePlugin({
      name: "terminal.core-failure",
      requires: { missing },
      setup() {},
    });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "terminal.core-failure", version: "1.0.0" },
      reference: "unused",
      placeholder,
    });

    await expect(change.commit()).rejects.toMatchObject({ code: "SERVICE_MISSING" });
    await expect(registration.ready()).rejects.toMatchObject({
      name: "DougongError",
      code: "SERVICE_MISSING",
    });
    await platform.dispose();
    await host.stop();
  });

  it("normalizes and freezes manifests at the trust boundary", () => {
    const manifest = defineManifest({ name: "demo", version: "1.2.3" });
    expect(manifest).toEqual({
      name: "demo",
      version: "1.2.3",
      apiVersion: "*",
      activation: ["startup"],
      permissions: [],
      dependencies: {},
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.activation)).toBe(true);
    expect(() => defineManifest({ name: "demo", version: "nope" })).toThrow(PlatformError);
    expect(() => defineManifest({ name: "demo", version: "nope" })).toThrow(DougongError);
    expect(() => defineManifest({ name: " demo", version: "1.0.0" })).toThrow(PlatformError);
    expect(() =>
      defineManifest({
        name: "demo",
        version: "1.0.0",
        dependencies: { dependency: "not-a-range" },
      }),
    ).toThrow(PlatformError);
    expect(() =>
      defineManifest({
        name: "demo",
        version: "1.0.0",
        permissions: ["fs", "fs"],
      }),
    ).toThrow("duplicate permission");
  });

  it("rejects malformed optional placeholders instead of treating them as absent", () => {
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    expect(() =>
      platform.change().register({
        manifest: { name: "demo.placeholder", version: "1.0.0" },
        reference: "missing",
        placeholder: null,
      } as never),
    ).toThrow("Plugin name must be a non-empty string");
  });

  it("reports which Artifact candidate disagrees with its Manifest identity", async () => {
    const loadedPlugin = definePlugin({ name: "wrong.loaded", setup() {} });
    const placeholderPlugin = definePlugin({ name: "wrong.placeholder", setup() {} });
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["loaded", { default: loadedPlugin }]])),
    });

    expect(() =>
      platform.change().register({
        manifest: { name: "expected.placeholder", version: "1.0.0" },
        reference: "unused",
        placeholder: placeholderPlugin,
      }),
    ).toThrowError(
      new PlatformError(
        "ARTIFACT_IDENTITY",
        "Artifact Manifest 'expected.placeholder' does not match placeholder Plugin 'wrong.placeholder'",
      ),
    );

    const registration = await platform.register({
      manifest: { name: "expected.loaded", version: "1.0.0" },
      reference: "loaded",
    });
    await expect(registration.activate()).rejects.toThrowError(
      new PlatformError(
        "ARTIFACT_IDENTITY",
        "Artifact Manifest 'expected.loaded' does not match loaded Plugin 'wrong.loaded'",
      ),
    );
    await platform.dispose();
  });

  it("loads trusted ESM through the abort-aware import adapter", async () => {
    const loader = new ImportLoader();
    const module = (await loader.load(
      "data:text/javascript,export const value = 42",
      new AbortController().signal,
    )) as { value: number };
    expect(module.value).toBe(42);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      loader.load("data:text/javascript,export default 1", controller.signal),
    ).rejects.toThrow("cancelled");
  });

  it("stages a lazy placeholder and atomically replaces it on activation", async () => {
    const SURFACES = extensionPoint<string>("platform/surfaces");
    const trace: string[] = [];
    const placeholder = definePlugin({
      name: "demo.lazy",
      setup(ctx) {
        trace.push("placeholder:start");
        ctx.contribute(SURFACES, "main", "placeholder");
        ctx.cleanup(() => trace.push("placeholder:stop"));
      },
    });
    const active = definePlugin({
      name: "demo.lazy",
      setup(ctx) {
        trace.push("active:start");
        ctx.contribute(SURFACES, "main", "active");
        ctx.cleanup(() => trace.push("active:stop"));
      },
    });

    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["lazy", { default: active }]])),
    });
    const registration = await platform.register({
      manifest: {
        name: "demo.lazy",
        version: "1.0.0",
        apiVersion: "^1.0.0",
        activation: ["command:open"],
      },
      reference: "lazy",
      placeholder,
    });

    await host.start();
    const installationId = [...host.diagnostics.get().installations.keys()][0];
    expect(registration.status).toBe("registered");
    expect(trace).toEqual(["placeholder:start"]);

    const ready = registration.ready();
    await platform.trigger("command:open");
    await ready;

    expect(registration.status).toBe("activated");
    expect(trace).toEqual(["placeholder:start", "placeholder:stop", "active:start"]);
    expect([...host.diagnostics.get().installations.keys()]).toEqual([installationId]);

    await registration.remove();
    expect(registration.status).toBe("removed");
    expect(trace.at(-1)).toBe("active:stop");
    await host.stop();
  });

  it("reconciles placeholder presence before lazy activation", async () => {
    const trace: string[] = [];
    const placeholder = (version: string) =>
      definePlugin({
        name: "demo.placeholder-reconcile",
        setup(ctx) {
          trace.push(`${version}:start`);
          ctx.cleanup(() => trace.push(`${version}:stop`));
        },
      });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    const registration = await platform.register({
      manifest: { name: "demo.placeholder-reconcile", version: "1.0.0" },
      reference: "unused-v1",
      placeholder: placeholder("v1"),
    });
    await host.start();

    await registration.update({
      manifest: { name: "demo.placeholder-reconcile", version: "1.1.0" },
      reference: "unused-v2",
      placeholder: placeholder("v2"),
    });
    expect(trace).toEqual(["v1:start", "v1:stop", "v2:start"]);

    await registration.update({
      manifest: { name: "demo.placeholder-reconcile", version: "1.2.0" },
      reference: "unused-v3",
    });
    expect(trace).toEqual(["v1:start", "v1:stop", "v2:start", "v2:stop"]);
    expect(host.diagnostics.get().installations.size).toBe(0);

    await registration.update({
      manifest: { name: "demo.placeholder-reconcile", version: "1.3.0" },
      reference: "unused-v4",
      placeholder: placeholder("v3"),
    });
    expect(trace.at(-1)).toBe("v3:start");
    expect(registration.status).toBe("registered");

    await platform.dispose();
    await host.stop();
  });

  it("activates compatible manifest dependencies before their consumers", async () => {
    const DATABASE = service<{ read(): string }>("platform/database");
    const trace: string[] = [];
    const database = definePlugin({
      name: "demo.database",
      provides: { database: DATABASE },
      setup() {
        trace.push("database");
        return { database: { read: () => "value" } };
      },
    });
    const consumer = definePlugin({
      name: "demo.consumer",
      requires: { database: DATABASE },
      setup(ctx) {
        trace.push(`consumer:${ctx.database.read()}`);
      },
    });

    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "2.1.0",
      loader: new MemoryLoader(
        new Map([
          ["database", { default: database }],
          ["consumer", { default: consumer }],
        ]),
      ),
    });
    const dependency = await platform.register({
      manifest: {
        name: "demo.database",
        version: "1.4.0",
        apiVersion: "^2.0.0",
        activation: ["manual"],
      },
      reference: "database",
    });
    const dependent = await platform.register({
      manifest: {
        name: "demo.consumer",
        version: "1.0.0",
        apiVersion: "^2.0.0",
        activation: ["startup"],
        dependencies: { "demo.database": "^1.3.0" },
      },
      reference: "consumer",
    });

    await platform.trigger("startup");

    expect(trace).toEqual(["database", "consumer:value"]);
    expect(dependency.status).toBe("activated");
    expect(dependent.status).toBe("activated");
    await host.stop();
  });

  it("enforces API compatibility and explicit permission policy before execution", async () => {
    expect(() => new PermissionSet("filesystem" as never)).toThrow(
      "PermissionSet permissions must be an iterable object",
    );
    expect(() => new PermissionSet([""])).toThrow("PermissionSet entry must be a non-empty string");
    expect(() => new PermissionSet([" filesystem"])).toThrow(
      "PermissionSet entry cannot start or end with whitespace",
    );

    const plugin = definePlugin({ name: "demo.secure", setup() {} });
    const modules = new MemoryLoader(new Map([["secure", { default: plugin }]]));
    const host = createHost();

    const denied = createPlatform({ installer: host, apiVersion: "1.0.0", loader: modules });
    const denial = await denied
      .register({
        manifest: { name: "demo.secure", version: "1.0.0", permissions: ["filesystem"] },
        reference: "secure",
      })
      .catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(PermissionDeniedError);
    expect(denial).toMatchObject({
      manifestName: "demo.secure",
      denied: ["filesystem"],
    });
    if (!(denial instanceof PermissionDeniedError)) throw denial;
    expect(Object.isFrozen(denial.denied)).toBe(true);

    const allowed = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: modules,
      authorizer: new PermissionSet(["filesystem"]),
    });
    await expect(
      allowed.register({
        manifest: {
          name: "demo.secure",
          version: "1.0.0",
          apiVersion: "^2.0.0",
          permissions: ["filesystem"],
        },
        reference: "secure",
      }),
    ).rejects.toMatchObject({ code: "API_INCOMPATIBLE" });
  });

  it("classifies non-Error admission failures at the ChangeSet boundary", async () => {
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
      authorizer: {
        authorize() {
          throw undefined;
        },
      },
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "failed.admission", version: "1.0.0" },
      reference: "unused",
    });

    const commandFailure = await change.commit().catch((error: unknown) => error);
    expect(commandFailure).toMatchObject({
      name: "PlatformError",
      code: "REGISTRATION_UNAVAILABLE",
      message: "Registration 'failed.admission' failed with a non-Error value",
    });
    const stableFailure = await registration.ready().catch((error: unknown) => error);
    expect(stableFailure).toMatchObject({
      name: "PlatformError",
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(stableFailure).not.toBe(commandFailure);
    expect(registration.status).toBe("failed");
    await platform.dispose();
  });

  it("updates an active plugin through the existing Core Installation", async () => {
    const trace: string[] = [];
    const v1 = definePlugin({
      name: "demo.hmr",
      setup(ctx) {
        trace.push("v1:start");
        ctx.cleanup(() => trace.push("v1:stop"));
      },
    });
    const v2 = definePlugin({
      name: "demo.hmr",
      setup(ctx) {
        trace.push("v2:start");
        ctx.cleanup(() => trace.push("v2:stop"));
      },
    });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["v1", { default: v1 }],
          ["v2", { default: v2 }],
        ]),
      ),
    });
    const registration = await platform.register({
      manifest: { name: "demo.hmr", version: "1.0.0" },
      reference: "v1",
    });
    await registration.activate();
    const id = [...host.diagnostics.get().installations.keys()][0];

    await registration.update({
      manifest: { name: "demo.hmr", version: "1.1.0" },
      reference: "v2",
    });

    expect(trace).toEqual(["v1:start", "v1:stop", "v2:start"]);
    expect([...host.diagnostics.get().installations.keys()]).toEqual([id]);
    expect(registration.manifest.version).toBe("1.1.0");
    await host.stop();
  });

  it("keeps the previous Artifact when Core rejects a prepared update", async () => {
    const positive = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          return typeof value === "number" && value > 0
            ? { value }
            : { issues: [{ message: "must be positive" }] };
        },
      },
    };
    const trace: string[] = [];
    const v1 = definePlugin({
      name: "demo.rollback",
      config: positive,
      setup(_ctx, config) {
        trace.push(`v1:${config}`);
      },
    });
    const v2 = definePlugin({
      name: "demo.rollback",
      config: positive,
      setup(_ctx, config) {
        trace.push(`v2:${config}`);
      },
    });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["rollback-v1", { default: v1 }],
          ["rollback-v2", { default: v2 }],
        ]),
      ),
    });
    const registration = await platform.register({
      manifest: { name: "demo.rollback", version: "1.0.0" },
      reference: "rollback-v1",
      config: 1,
    });
    await registration.activate();

    await expect(
      registration.update({
        manifest: { name: "demo.rollback", version: "2.0.0" },
        reference: "rollback-v2",
        config: -1,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect(registration.manifest.version).toBe("1.0.0");
    expect(registration.status).toBe("activated");
    expect(trace).toEqual(["v1:1"]);
    await platform.dispose();
    await host.stop();
  });

  it("reports missing, incompatible and cyclic manifest dependencies", async () => {
    const a = definePlugin({ name: "demo.a", setup() {} });
    const b = definePlugin({ name: "demo.b", setup() {} });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["a", { default: a }],
          ["b", { default: b }],
        ]),
      ),
    });

    const missing = await platform.register({
      manifest: {
        name: "demo.a",
        version: "1.0.0",
        activation: ["missing"],
        dependencies: { "demo.nope": "^1.0.0" },
      },
      reference: "a",
    });
    await expect(missing.activate()).rejects.toMatchObject({
      code: "REGISTRATION_DEPENDENCY_MISSING",
    });
    await missing.remove();

    const first = await platform.register({
      manifest: {
        name: "demo.a",
        version: "1.0.0",
        activation: ["cycle"],
        dependencies: { "demo.b": "^1.0.0" },
      },
      reference: "a",
    });
    await expect(
      platform.register({
        manifest: {
          name: "demo.b",
          version: "1.0.0",
          activation: ["cycle"],
          dependencies: { "demo.a": "^1.0.0" },
        },
        reference: "b",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CYCLE" });

    await first.remove();
    await host.stop();
  });

  it("rejects an activated Registration whose dependency Registration is inactive", async () => {
    const consumerPlugin = definePlugin({ name: "inactive.consumer", setup() {} });
    const dependencyPlugin = definePlugin({ name: "inactive.dependency", setup() {} });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["consumer", { default: consumerPlugin }],
          ["dependency", { default: dependencyPlugin }],
        ]),
      ),
    });

    await platform.register({
      manifest: { name: "inactive.dependency", version: "1.0.0", activation: ["manual"] },
      reference: "dependency",
    });
    const consumer = await platform.register({
      manifest: { name: "inactive.consumer", version: "1.0.0", activation: ["manual"] },
      reference: "consumer",
    });
    await consumer.activate();

    await expect(
      consumer.update({
        manifest: {
          name: "inactive.consumer",
          version: "1.1.0",
          activation: ["manual"],
          dependencies: { "inactive.dependency": "^1.0.0" },
        },
        reference: "consumer",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_DEPENDENCY_INACTIVE" });

    await platform.dispose();
    await host.stop();
  });

  it("migrates active manifest and Core contracts in one canonical ChangeSet", async () => {
    const API = service<{ version: number }>("platform/migration-api");
    const trace: string[] = [];
    const providerV1 = definePlugin({
      name: "migration.provider",
      provides: { api: API },
      setup: () => ({ api: { version: 1 } }),
    });
    const providerV2 = definePlugin({
      name: "migration.provider",
      provides: { api: API },
      setup: () => ({ api: { version: 2 } }),
    });
    const consumerV1 = definePlugin({
      name: "migration.consumer",
      requires: { api: API },
      setup: (ctx) => {
        trace.push(`consumer:${ctx.api.version}`);
      },
    });
    const consumerV2 = definePlugin({
      name: "migration.consumer",
      requires: { api: API },
      setup: (ctx) => {
        trace.push(`consumer:${ctx.api.version}`);
      },
    });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["provider-v1", { default: providerV1 }],
          ["provider-v2", { default: providerV2 }],
          ["consumer-v1", { default: consumerV1 }],
          ["consumer-v2", { default: consumerV2 }],
        ]),
      ),
    });
    const provider = await platform.register({
      manifest: { name: "migration.provider", version: "1.0.0" },
      reference: "provider-v1",
    });
    const consumer = await platform.register({
      manifest: {
        name: "migration.consumer",
        version: "1.0.0",
        dependencies: { "migration.provider": "^1.0.0" },
      },
      reference: "consumer-v1",
    });
    await consumer.activate();
    expect(trace).toEqual(["consumer:1"]);

    await expect(
      provider.update({
        manifest: { name: "migration.provider", version: "2.0.0" },
        reference: "provider-v2",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_DEPENDENCY_INCOMPATIBLE" });

    const change = platform.change();
    change.update(provider, {
      manifest: { name: "migration.provider", version: "2.0.0" },
      reference: "provider-v2",
    });
    change.update(consumer, {
      manifest: {
        name: "migration.consumer",
        version: "2.0.0",
        dependencies: { "migration.provider": "^2.0.0" },
      },
      reference: "consumer-v2",
    });
    await change.commit();

    expect(trace).toEqual(["consumer:1", "consumer:2"]);
    expect(provider.manifest.version).toBe("2.0.0");
    expect(consumer.manifest.version).toBe("2.0.0");
    await platform.dispose();
    await host.stop();
  });

  it("separates module activation from the Core ready barrier and owns disposal", async () => {
    const plugin = definePlugin({ name: "demo.lifecycle", setup() {} });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["lifecycle", { default: plugin }]])),
    });
    const revisions: number[] = [];
    const subscription = platform.diagnostics.subscribe(() => {
      revisions.push(platform.diagnostics.get().revision);
    });
    const registration = await platform.register({
      manifest: { name: "demo.lifecycle", version: "1.0.0" },
      reference: "lifecycle",
    });
    let ready = false;
    const barrier = registration.ready().then(() => {
      ready = true;
    });

    await registration.activate();
    await Promise.resolve();
    expect(registration.status).toBe("activated");
    expect(ready).toBe(false);

    await host.start();
    await barrier;
    const snapshot = platform.diagnostics.get();
    expect(snapshot.registrations.get("demo.lifecycle")).toMatchObject({
      manifestName: "demo.lifecycle",
      status: "activated",
      version: "1.0.0",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.registrations.get("demo.lifecycle"))).toBe(true);
    expect("set" in snapshot.registrations).toBe(false);
    expect(snapshot.registrations.size).toBe(1);
    expect(snapshot.registrations.has("demo.lifecycle")).toBe(true);
    expect([...snapshot.registrations.keys()]).toEqual(["demo.lifecycle"]);
    expect([...snapshot.registrations.values()]).toHaveLength(1);
    expect([...snapshot.registrations.entries()]).toHaveLength(1);
    expect([...snapshot.registrations]).toHaveLength(1);
    let visits = 0;
    snapshot.registrations.forEach(() => visits++);
    expect(visits).toBe(1);
    expect(revisions.length).toBeGreaterThan(1);

    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingSubscription = platform.diagnostics.subscribe(() => {
      throw new Error("diagnostic subscriber failed");
    });
    await registration.update({
      manifest: { name: "demo.lifecycle", version: "1.1.0" },
      reference: "lifecycle",
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "diagnostic subscriber failed" }),
    );
    failingSubscription.dispose();
    failingSubscription.dispose();
    expect(() => platform.diagnostics.subscribe(undefined as never)).toThrow(
      "Subscriber must be a function",
    );

    await platform.dispose();
    expect(platform.status).toBe("disposed");
    expect(registration.status).toBe("removed");
    expect(host.diagnostics.get().installations.size).toBe(0);
    await expect(registration.remove()).resolves.toBeUndefined();
    await expect(registration.activate()).rejects.toMatchObject({ code: "REGISTRATION_REMOVED" });
    expect(() => platform.diagnostics.subscribe(() => undefined)).toThrow(
      "Snapshot publisher is disposed",
    );
    await platform.dispose();
    subscription.dispose();
    await host.stop();
  });

  it("reauthorizes immediately before module execution and supports an explicit retry", async () => {
    const plugin = definePlugin({ name: "demo.reauthorize", setup() {} });
    let allowed = true;
    const authorize = vi.fn<(manifest: Manifest, signal: AbortSignal) => void>(() => {
      if (!allowed) throw new PermissionDeniedError("demo.reauthorize", ["network"]);
    });
    const load = vi.fn<(reference: string, signal: AbortSignal) => unknown>(() => ({
      default: plugin,
    }));
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      authorizer: { authorize },
      loader: { load },
    });
    const registration = await platform.register({
      manifest: {
        name: "demo.reauthorize",
        version: "1.0.0",
        permissions: ["network"],
      },
      reference: "secure",
    });

    allowed = false;
    await expect(registration.activate()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(load).not.toHaveBeenCalled();
    expect(registration.status).toBe("failed");

    allowed = true;
    await registration.activate();
    expect(load).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledTimes(3);
    await platform.dispose();
    await host.stop();
  });

  it("attempts every matching activation and aggregates independent failures", async () => {
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: { load: () => Promise.reject(new Error("unavailable")) },
    });
    await platform.register({
      manifest: { name: "failed.one", version: "1.0.0", activation: ["event"] },
      reference: "one",
    });
    await platform.register({
      manifest: { name: "failed.two", version: "1.0.0", activation: ["event"] },
      reference: "two",
    });

    const failure = await platform.trigger("event").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(
      [...platform.diagnostics.get().registrations.values()].map(
        (registration) => registration.status,
      ),
    ).toEqual(["failed", "failed"]);
    await platform.dispose();
  });

  it("classifies non-Error activation failures for stable registration state", async () => {
    const failure: unknown = undefined;
    let failAuthorization = false;
    const host = createHost();
    const plugin = definePlugin({ name: "failed.non-error", setup() {} });
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["failure", { default: plugin }]])),
      authorizer: {
        authorize() {
          if (failAuthorization) throw failure;
        },
      },
    });
    const registration = await platform.register({
      manifest: { name: "failed.non-error", version: "1.0.0", activation: ["event"] },
      reference: "failure",
    });

    failAuthorization = true;
    const activationFailure = await registration.activate().catch((error: unknown) => error);
    expect(activationFailure).toMatchObject({
      name: "PlatformError",
      code: "REGISTRATION_UNAVAILABLE",
      message: "Registration 'failed.non-error' failed with a non-Error value",
    });
    const classified = await registration.ready().catch((error: unknown) => error);
    expect(classified).toMatchObject({
      name: "PlatformError",
      code: "REGISTRATION_UNAVAILABLE",
      message: "Registration 'failed.non-error' failed with a non-Error value",
    });
    expect(classified).toBe(activationFailure);
    expect(platform.diagnostics.get().registrations.get(registration.manifest.name)?.error).toBe(
      classified,
    );
    await platform.dispose();
  });

  it("serializes activation behind the Registration commit that grants authority", async () => {
    const plugin = definePlugin({ name: "demo.commit-activation", setup() {} });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["plugin", { default: plugin }]])),
    });
    const change = platform.change();
    const registration = change.register({
      manifest: { name: "demo.commit-activation", version: "1.0.0" },
      reference: "plugin",
    });

    const committing = change.commit();
    const activating = registration.activate();
    await expect(Promise.all([committing, activating])).resolves.toEqual([undefined, undefined]);
    await expect(registration.ready()).resolves.toBeUndefined();
    expect(registration.status).toBe("activated");

    await platform.dispose();
    await host.stop();
  });

  it("makes Platform ChangeSet one-shot, authoritative and commit-idempotent", async () => {
    const plugin = definePlugin({ name: "demo.change-owner", setup() {} });
    const modules = new MemoryLoader(new Map([["plugin", { default: plugin }]]));
    const first = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: modules,
    });
    const second = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: modules,
    });
    const registration = await first.register({
      manifest: { name: "demo.change-owner", version: "1.0.0" },
      reference: "plugin",
    });
    expect(() => second.change().remove(registration)).toThrow("different Platform");

    const change = first.change();
    change.update(registration, {
      manifest: { name: "demo.change-owner", version: "1.1.0" },
      reference: "plugin",
    });
    expect(() => change.remove(registration)).toThrow("can only appear once");
    const committing = change.commit();
    expect(change.commit()).toBe(committing);
    expect(() =>
      change.register({
        manifest: { name: "demo.late", version: "1.0.0" },
        reference: "plugin",
      }),
    ).toThrow("submitted ChangeSet");
    await committing;
    expect(registration.manifest.version).toBe("1.1.0");
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("cancels in-flight activation before removing its stable identity", async () => {
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: {
        load(_reference: string, signal: AbortSignal) {
          entered();
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const registration = await platform.register({
      manifest: { name: "demo.cancel", version: "1.0.0" },
      reference: "slow",
    });

    const activation = registration.activate();
    await loading;
    const removal = registration.remove();
    await expect(activation).rejects.toBeDefined();
    await removal;

    expect(registration.status).toBe("removed");
    const repeated = platform.change();
    repeated.remove(registration);
    await expect(repeated.commit()).resolves.toBeUndefined();
    expect(host.diagnostics.get().installations.size).toBe(0);
    await platform.dispose();
  });

  it("preserves a Loader failure that merely races activation cancellation", async () => {
    const failure = new Error("loader shutdown failed");
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: {
        load(_reference: string, signal: AbortSignal) {
          entered();
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(failure), { once: true });
          });
        },
      },
    });
    const registration = await platform.register({
      manifest: { name: "demo.cancel-failure", version: "1.0.0" },
      reference: "slow",
    });

    const activation = registration.activate();
    await loading;
    const disposal = platform.dispose();

    await expect(activation).rejects.toMatchObject({
      code: "MODULE_LOAD_FAILED",
      cause: failure,
    });
    await disposal;
    expect(registration.status).toBe("removed");
  });
});

async function createTerminalRegistration() {
  const host = createHost();
  const loader = new MemoryLoader(new Map());
  const platform = createPlatform({ installer: host, apiVersion: "1.0.0", loader });
  const registration = await platform.register({
    manifest: { name: "retention.registration", version: "1.0.0" },
    reference: "unused",
  });
  const references = {
    host: new WeakRef(host),
    loader: new WeakRef(loader),
    platform: new WeakRef(platform),
  };
  await platform.dispose();
  return { registration, references };
}

async function createHistoricalPlatformDiagnostics() {
  const host = createHost();
  const loader = new MemoryLoader(new Map());
  const platform = createPlatform({ installer: host, apiVersion: "1.0.0", loader });
  const diagnostics = platform.diagnostics;
  const subscription = diagnostics.subscribe(() => {
    void host;
    void loader;
    void platform;
  });
  const references = {
    host: new WeakRef(host),
    loader: new WeakRef(loader),
    platform: new WeakRef(platform),
  };
  await platform.dispose();
  return { diagnostics, subscription, references };
}

async function createAbandonedRegistration() {
  const host = createHost();
  const loader = new MemoryLoader(new Map());
  const platform = createPlatform({ installer: host, apiVersion: "1.0.0", loader });
  await platform.register({
    manifest: { name: "retention.abandoned-registration", version: "1.0.0" },
    reference: "first",
  });
  const change = platform.change();
  const registration = change.register({
    manifest: { name: "retention.abandoned-registration", version: "1.0.0" },
    reference: "duplicate",
  });
  const references = {
    host: new WeakRef(host),
    loader: new WeakRef(loader),
    platform: new WeakRef(platform),
  };
  await change.commit().catch(() => undefined);
  await platform.dispose();
  return { registration, references };
}
