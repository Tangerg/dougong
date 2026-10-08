import { expect, it, vi } from "vitest";
import { createHost, definePlugin } from "@dougongjs/core";
import { createPlatform, defineManifest, MemoryLoader } from "../src";

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
