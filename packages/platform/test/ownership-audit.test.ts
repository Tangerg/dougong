import { expect, it, vi } from "vitest";
import { createHost, definePlugin, type ChangeSet } from "@dougongjs/core";
import { createPlatform, defineManifest, MemoryLoader } from "../src";

it("does not commit a loaded Plugin when cancellation arrives before the Core handoff", async () => {
  const host = createHost();
  await host.start();
  const setup = vi.fn<() => void>(() => undefined);
  const plugin = definePlugin({ name: "audit.cancelled-handoff", setup });
  let disposal: Promise<void> | undefined;
  const platform = createPlatform({
    installer: host,
    apiVersion: "1.0.0",
    loader: {
      load() {
        queueMicrotask(() => {
          queueMicrotask(() => {
            disposal = platform.dispose();
          });
        });
        return { default: plugin };
      },
    },
  });
  const registration = await platform.register({
    manifest: defineManifest({ name: plugin.name, version: "1.0.0" }),
    reference: "plugin",
  });
  const [activation] = await Promise.allSettled([registration.activate()]);
  await disposal;
  await host.stop();
  expect(activation).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  expect(setup).not.toHaveBeenCalled();
  expect(platform.status).toBe("disposed");
  expect(host.diagnostics.get().installations.size).toBe(0);
});

it("does not start another authorization after its Platform change was cancelled", async () => {
  const host = createHost();
  let disposal: Promise<void> | undefined;
  const authorize = vi.fn<() => void>(() => {
    disposal = platform.dispose();
  });
  const platform = createPlatform({
    installer: host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
    authorizer: { authorize },
  });
  const change = platform.change();
  for (const name of ["audit.cancelled-first", "audit.cancelled-second"]) {
    change.register({ manifest: defineManifest({ name, version: "1.0.0" }), reference: name });
  }
  const [admission] = await Promise.allSettled([change.commit()]);
  await disposal;
  expect(admission).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(platform.status).toBe("disposed");
});

it("does not start authorization when a loading observer cancels activation", async () => {
  const authorize = vi.fn<() => void>(() => undefined);
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
    authorizer: { authorize },
  });
  const registration = await platform.register({
    manifest: defineManifest({ name: "audit.cancelled-authorization", version: "1.0.0" }),
    reference: "plugin",
  });
  authorize.mockClear();
  let disposal: Promise<void> | undefined;
  platform.diagnostics.subscribe(() => {
    if (platform.status === "active" && registration.status === "loading") {
      disposal = platform.dispose();
    }
  });
  const [activation] = await Promise.allSettled([registration.activate()]);
  await disposal;
  expect(activation).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  expect(authorize).not.toHaveBeenCalled();
  expect(platform.status).toBe("disposed");
});

it.each(["activation", "admission"])(
  "checks cancellation after Core staging during %s",
  async (phase) => {
    const host = createHost();
    await host.start();
    const setup = vi.fn<() => void>(() => undefined);
    const plugin = definePlugin({ name: "audit.cancelled-staging", setup });
    let disposal: Promise<void> | undefined;
    const installer = {
      change(): ChangeSet {
        const change = host.change();
        return {
          install(declaration, ...config) {
            const installation = change.install(declaration, ...config);
            disposal = platform.dispose();
            return installation;
          },
          update: change.update.bind(change),
          remove: change.remove.bind(change),
          commit: change.commit.bind(change),
        };
      },
    };
    const platform = createPlatform({
      installer,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["plugin", { default: plugin }]])),
    });
    const artifact = {
      manifest: defineManifest({ name: plugin.name, version: "1.0.0" }),
      reference: "plugin",
    };
    const operation =
      phase === "admission"
        ? platform.register({ ...artifact, placeholder: plugin })
        : (await platform.register(artifact)).activate();
    const [result] = await Promise.allSettled([operation]);
    await disposal;
    await host.stop();
    expect(result).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(setup).not.toHaveBeenCalled();
    expect(platform.status).toBe("disposed");
    expect(host.diagnostics.get().installations.size).toBe(0);
  },
);

it("does not retain a Host through a historical failed Registration snapshot", async () => {
  const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");
  const fixture = await createHistoricalFailureSnapshot();
  for (let pass = 0; pass < 8 && fixture.reference.deref(); pass++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    forceGc();
    forceGc();
  }
  expect(fixture.snapshot?.status).toBe("failed");
  expect(fixture.reference.deref()).toBeUndefined();
});

async function createHistoricalFailureSnapshot() {
  const host = createHost();
  const reference = new WeakRef(host);
  const platform = createPlatform({
    installer: host,
    apiVersion: "1.0.0",
    loader: {
      load() {
        throw new Error("historical failure", { cause: host });
      },
    },
  });
  const registration = await platform.register({
    manifest: defineManifest({ name: "audit.historical-failure", version: "1.0.0" }),
    reference: "failure",
  });
  await registration.activate().catch(() => undefined);
  const snapshot = platform.diagnostics.get().registrations.get(registration.manifest.name);
  await registration.remove();
  await platform.dispose();
  return { snapshot, reference };
}

it("reports final Platform observer failures before releasing its logger", async () => {
  const error = vi.fn<(error: unknown) => void>();
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
    logger: { debug() {}, info() {}, warn() {}, error },
  });
  const failure = new Error("terminal platform subscriber");
  platform.diagnostics.subscribe(() => {
    if (platform.status === "disposed") throw failure;
  });
  await platform.dispose();
  expect(error).toHaveBeenCalledExactlyOnceWith(failure);
});

it("joins concurrent removal requests for one Registration", async () => {
  const host = createHost();
  const plugin = definePlugin({ name: "audit.concurrent-removal", setup() {} });
  const platform = createPlatform({
    installer: host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["plugin", { default: plugin }]])),
  });
  const registration = await platform.register({
    manifest: defineManifest({ name: plugin.name, version: "1.0.0" }),
    reference: "plugin",
  });
  await registration.activate();
  await host.start();
  const results = await Promise.allSettled([registration.remove(), registration.remove()]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  await platform.dispose();
  await host.stop();
});

it("does not remove a replacement Registration when an old removal intent is queued twice", async () => {
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
  });
  const manifest = defineManifest({ name: "audit.reused-name", version: "1.0.0" });
  const old = await platform.register({ manifest, reference: "old" });
  const first = old.remove();
  const change = platform.change();
  const replacement = change.register({
    manifest: { ...manifest, version: "2.0.0" },
    reference: "new",
  });
  const replaced = change.commit();
  const repeated = old.remove();
  await Promise.all([first, replaced, repeated]);
  expect(old.status).toBe("removed");
  expect(replacement.status).toBe("registered");
  expect(platform.diagnostics.get().registrations.get(manifest.name)?.version).toBe("2.0.0");
  await platform.dispose();
});
