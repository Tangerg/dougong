import { expect, it } from "vitest";
import { createResourceAuthority, createHost, definePlugin } from "dougong";
import { createPlatform, type RegistrationSnapshot } from "../src";
import { add, deferred, emptyPlugin, fixture, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it("pairs installed origins with stopped, changing and running execution", async () => {
  const preparing = deferred();
  const prepared = deferred();
  const releasing = deferred();
  const released = deferred();
  const plugin = definePlugin({
    name: "sample",
    async setup({ lifetime }) {
      lifetime.defer(async () => {
        releasing.resolve();
        await released.promise;
      });
      preparing.resolve();
      await prepared.promise;
    },
  });
  const { host, platform } = fixture(resourceAuthority, new Map([["stable", plugin]]));
  const registration = await select(platform, "sample", "stable");
  await platform.activate([registration]);
  const origin = registration.activeOrigin;
  const snapshots: RegistrationSnapshot[] = [];
  using _subscription = platform.diagnostics.subscribe(() => {
    const snapshot = platform.diagnostics.get().registrations.get("sample");
    if (snapshot?.status === "installed") snapshots.push(snapshot);
  });
  const snapshot = () => platform.diagnostics.get().registrations.get("sample");
  let transition: Promise<unknown> | undefined;
  try {
    expect(origin).toBeDefined();
    expect(snapshot()).toMatchObject({
      status: "installed",
      activeOrigin: origin,
      execution: "stopped",
      error: undefined,
    });
    transition = host.start();
    await preparing.promise;
    expect(snapshot()).toMatchObject({
      status: "installed",
      activeOrigin: origin,
      execution: "changing",
    });
    prepared.resolve();
    await transition;
    expect(snapshot()).toMatchObject({
      status: "installed",
      activeOrigin: origin,
      execution: "running",
    });
    transition = host.stop();
    await releasing.promise;
    expect(snapshot()).toMatchObject({
      status: "installed",
      activeOrigin: origin,
      execution: "changing",
    });
    released.resolve();
    await transition;
    expect(snapshot()).toMatchObject({
      status: "installed",
      activeOrigin: origin,
      execution: "stopped",
    });
    for (const observed of snapshots) {
      expect(observed.activeOrigin).toBe(origin);
      expect(observed.execution).toBeDefined();
      expect(observed.error).toBeUndefined();
    }
  } finally {
    prepared.resolve();
    released.resolve();
    await transition;
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});

it("retains a failed selection's diagnostic while removing its metadata", async () => {
  const { platform } = fixture(resourceAuthority);
  const registration = await select(platform, "sample", "missing");
  expect(platform.diagnostics.get().registrations.get("sample")).toMatchObject({
    status: "selected",
    activeOrigin: undefined,
    execution: undefined,
    error: undefined,
  });
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const failed = platform.diagnostics.get().registrations.get("sample")!;
  expect(failed).toMatchObject({
    status: "failed",
    activeOrigin: undefined,
    execution: undefined,
    error: { code: "MODULE_LOAD_FAILED" },
  });
  expect(Object.isFrozen(failed)).toBe(true);
  expect(platform.diagnostics.get().registrations.get("sample")).toBe(failed);
  let removing: RegistrationSnapshot | undefined;
  using _subscription = platform.diagnostics.subscribe(() => {
    const current = platform.diagnostics.get().registrations.get("sample");
    if (current?.status === "removing") removing = current;
  });
  await platform.remove(registration);
  expect(removing).toMatchObject({
    activeOrigin: undefined,
    execution: undefined,
  });
  expect(removing?.error).toBe(failed.error);
  expect(platform.diagnostics.get().registrations.has("sample")).toBe(false);
  expect(failed.status).toBe("failed");
  await platform[Symbol.asyncDispose]();
});

it("retains the previous failure during activation and clears it only after commit", async () => {
  const entered = deferred();
  const resume = deferred();
  let attempts = 0;
  const platform = createPlatform({
    id: "retry",
    host: createHost({ resourceAuthority }),
    apiVersion: "1.0.0",
    loader: {
      async load() {
        if (++attempts === 1) throw new Error("first load failed");
        entered.resolve();
        await resume.promise;
        return { default: emptyPlugin("sample") };
      },
    },
  });
  const registration = await select(platform, "sample", "module");
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const failed = platform.diagnostics.get().registrations.get("sample")!;
  const activation = platform.activate([registration]);
  try {
    await entered.promise;
    const activating = platform.diagnostics.get().registrations.get("sample")!;
    expect(activating).toMatchObject({
      status: "activating",
      activeOrigin: undefined,
      execution: undefined,
    });
    expect(activating.error).toBe(failed.error);
  } finally {
    resume.resolve();
    await activation;
  }
  expect(platform.diagnostics.get().registrations.get("sample")).toMatchObject({
    status: "installed",
    execution: "stopped",
    error: undefined,
  });
  await platform[Symbol.asyncDispose]();
});

it("preserves a selected revision's failure when its previous execution is quarantined", async () => {
  const plugin = definePlugin({
    name: "sample",
    setup({ lifetime }) {
      lifetime.defer(() => {
        throw new Error("cleanup failed");
      });
    },
  });
  const { host, platform } = fixture(resourceAuthority, new Map([["stable", plugin]]));
  const registration = await select(platform, "sample", "stable");
  await host.start();
  await platform.activate([registration]);
  await platform.select([add(platform, "sample", "missing", "2.0.0")]);
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const previousError = registration.error;
  const previousOrigin = registration.activeOrigin;
  expect(previousError).toBeDefined();
  expect(previousOrigin).toBeDefined();
  const snapshots: RegistrationSnapshot[] = [];
  using _subscription = platform.diagnostics.subscribe(() => {
    const snapshot = platform.diagnostics.get().registrations.get("sample");
    if (snapshot) snapshots.push(snapshot);
  });
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  const snapshot = platform.diagnostics.get().registrations.get("sample")!;
  expect(snapshot.status).toBe("quarantined");
  expect(snapshot.execution).toBe("quarantined");
  expect(snapshot.error).toBe(previousError);
  expect(snapshot.activeOrigin).toBe(previousOrigin);
  expect(snapshots).toContain(snapshot);
  for (const observed of snapshots) {
    expect(observed.status === "quarantined").toBe(observed.execution === "quarantined");
    expect(observed.activeOrigin).toBe(previousOrigin);
    expect(observed.error).toBe(previousError);
  }
});
