import { expect, it } from "vitest";
import { createHost, createResourceAuthority, definePlugin } from "dougong";
import { createPlatform, MemoryLoader } from "../src";

const resourceAuthority = createResourceAuthority();

it("preserves Core quarantine when cancelled setup does not cooperate", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const plugin = definePlugin({
    name: "sample",
    async setup({ lifetime }) {
      lifetime.defer(() => {
        cleaned.resolve();
      });
      entered.resolve();
      await release.promise;
    },
  });
  const host = createHost({ resourceAuthority, shutdownTimeoutMilliseconds: 1, onError() {} });
  const platform = createPlatform({
    id: "cancellation",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["sample", { default: plugin }]])),
  });
  const [registration] = await platform.select([
    platform.catalog.add({
      revision: "1",
      manifest: { name: "sample", version: "1.0.0" },
      reference: "sample",
    }),
  ]);
  await host.start();
  const controller = new AbortController();
  const activation = platform.activate([registration!], { signal: controller.signal });
  const outcome = activation.catch((error: unknown) => error);
  await entered.promise;
  controller.abort();
  try {
    expect(await outcome).toMatchObject({
      code: "HOST_QUARANTINED",
      details: { outcome: "quarantined" },
    });
    expect(host.status).toBe("quarantined");
    expect(host.diagnostics.get().unresolved).toHaveLength(1);
    expect(registration!.activeOrigin).toBeUndefined();
  } finally {
    release.resolve();
    await cleaned.promise;
    await platform[Symbol.asyncDispose]();
  }
});

it("keeps the committed activation when its caller cancels during commit notification", async () => {
  const plugin = definePlugin({ name: "sample", setup() {} });
  const host = createHost({ resourceAuthority });
  const platform = createPlatform({
    id: "committed",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["sample", { default: plugin }]])),
  });
  const [registration] = await platform.select([
    platform.catalog.add({
      revision: "1",
      manifest: { name: "sample", version: "1.0.0" },
      reference: "sample",
    }),
  ]);
  await host.start();
  const revision = host.stateRevision;
  const controller = new AbortController();
  const subscription = host.diagnostics.subscribe(() => {
    if (host.stateRevision > revision) controller.abort();
  });
  try {
    const result = await platform.activate([registration!], { signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(result?.stateRevision).toBe(host.stateRevision);
    expect(registration!.status).toBe("installed");
    expect(registration!.error).toBeUndefined();
  } finally {
    subscription[Symbol.dispose]();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});
