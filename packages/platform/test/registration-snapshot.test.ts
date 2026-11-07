import { expect, it } from "vitest";
import { createHost, definePlugin } from "dougong";
import { createPlatform, type RegistrationSnapshot } from "../src";
import { add, deferred, emptyPlugin, fixture, select } from "./fixtures";

it("retains a failed selection's diagnostic while removing its metadata", async () => {
  const { platform } = fixture();
  const registration = await select(platform, "sample", "missing");
  expect(platform.diagnostics.get().registrations.get("sample")).toMatchObject({
    status: "selected",
    execution: undefined,
    error: undefined,
  });
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const failed = platform.diagnostics.get().registrations.get("sample")!;
  expect(failed).toMatchObject({ status: "failed", error: { code: "MODULE_LOAD_FAILED" } });
  expect(Object.isFrozen(failed)).toBe(true);
  expect(platform.diagnostics.get().registrations.get("sample")).toBe(failed);
  let removing: RegistrationSnapshot | undefined;
  using _subscription = platform.diagnostics.subscribe(() => {
    const current = platform.diagnostics.get().registrations.get("sample");
    if (current?.status === "removing") removing = current;
  });
  await platform.remove(registration);
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
    host: createHost(),
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
    expect(activating.status).toBe("activating");
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
  const { host, platform } = fixture(new Map([["stable", plugin]]));
  const registration = await select(platform, "sample", "stable");
  await host.start();
  await platform.activate([registration]);
  await platform.select([add(platform, "sample", "missing", "2.0.0")]);
  await expect(platform.activate([registration])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  const previousError = registration.error;
  expect(previousError).toBeDefined();
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  const snapshot = platform.diagnostics.get().registrations.get("sample")!;
  expect(snapshot.status).toBe("quarantined");
  expect(snapshot.execution).toBe("quarantined");
  expect(snapshot.error).toBe(previousError);
});
