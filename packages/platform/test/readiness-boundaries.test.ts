import { expect, it } from "vitest";
import { createHost, definePlugin, type AnyPlugin } from "@dougongjs/core";
import { createPlatform, MemoryLoader } from "../src";

it.each([false, true])(
  "keeps Registration readiness behind a submitted Artifact update (rollback: %s)",
  async (rollback) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const old = definePlugin({ name: "readiness.update", setup() {} });
    const host = createHost();
    await host.start();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: {
        async load(reference: string) {
          if (reference === "next") {
            entered.resolve();
            await resume.promise;
          }
          return {
            default:
              reference === "next" && rollback
                ? definePlugin({
                    name: old.name,
                    setup() {
                      throw new Error("update failed");
                    },
                  })
                : old,
          };
        },
      },
    });
    const registration = await platform.register({
      manifest: { name: old.name, version: "1.0.0" },
      reference: "old",
    });
    await registration.activate();
    const update = registration.update({
      manifest: { name: old.name, version: "2.0.0" },
      reference: "next",
    });
    await entered.promise;
    let ready = false;
    const waiting = registration.ready().then(() => {
      ready = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const premature = ready;
    resume.resolve();
    const failure = await update.catch((error: unknown) => error);
    expect(failure).toEqual(rollback ? new Error("update failed") : undefined);
    await waiting;
    expect(registration.manifest.version).toBe(rollback ? "1.0.0" : "2.0.0");
    expect(registration.status).toBe("installed");
    await platform.dispose();
    await host.stop();
    expect(premature).toBe(false);
    expect(ready).toBe(true);
  },
);

it.each([false, true])(
  "keeps pending activation readiness when an inactive placeholder is withdrawn (Host active: %s)",
  async (active) => {
    const plugin = definePlugin({ name: "readiness.placeholder", setup() {} });
    const host = createHost();
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map<string, { default: AnyPlugin }>([["plugin", { default: plugin }]]),
      ),
    });
    const artifact = {
      manifest: { name: plugin.name, version: "1.0.0" },
      reference: "plugin",
    };
    const registration = await platform.register({ ...artifact, placeholder: plugin });
    if (active) await host.start();
    let outcome = "pending";
    const waiting = registration.ready().then(
      () => {
        outcome = "ready";
      },
      () => {
        outcome = "failed";
      },
    );
    await registration.update({
      ...artifact,
      manifest: { ...artifact.manifest, version: "2.0.0" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const afterWithdrawal = outcome;
    await registration.activate();
    if (!active) await host.start();
    await waiting;
    await platform.dispose();
    await host.stop();
    expect(afterWithdrawal).toBe("pending");
    expect(outcome).toBe("ready");
  },
);

it("rejects existing activation readiness when the Core owner removes the placeholder externally", async () => {
  const plugin = definePlugin({ name: "readiness.external-removal", setup() {} });
  const host = createHost();
  const group = host.group("delivery", () => undefined);
  const platform = createPlatform({
    installer: group,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
  });
  const registration = await platform.register({
    manifest: { name: plugin.name, version: "1.0.0" },
    reference: "plugin",
    placeholder: plugin,
  });
  await host.start();
  const waiting = registration.ready().catch((error: unknown) => error);
  await group.remove();
  expect(await waiting).toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });
  expect(registration.status).toBe("unavailable");
  await platform.dispose();
  await host.stop();
});
