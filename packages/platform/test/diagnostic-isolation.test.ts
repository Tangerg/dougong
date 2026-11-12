import { createHost, createResourceAuthority, definePlugin, type Host } from "dougong";
import { expect, it, vi } from "vitest";
import { createPlatform, MemoryLoader } from "../src";
import { add, deferred, emptyPlugin, nextTurn, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();

function withDiagnosticReader(host: Host, read: Host["diagnostics"]["get"]): Host {
  const diagnostics = { get: read, subscribe: host.diagnostics.subscribe };
  return new Proxy(host, {
    get(target, property, receiver) {
      return property === "diagnostics" ? diagnostics : Reflect.get(target, property, receiver);
    },
  });
}

it("keeps a committed selection independent of a failed diagnostic read", async () => {
  const host = createHost({ resourceAuthority });
  const failure = new Error("Host diagnostic projection is unavailable");
  let unreadable = false;
  const source = withDiagnosticReader(host, () => {
    if (unreadable) throw failure;
    return host.diagnostics.get();
  });
  const report = vi.fn<(error: unknown) => void>();
  const platform = createPlatform({
    id: "selection-diagnostic-isolation",
    host: source,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map<string, unknown>()),
    logger: { debug() {}, info() {}, warn() {}, error: report },
  });
  const artifact = add(platform, "sample", "sample");
  const subscription = platform.diagnostics.subscribe(() => undefined);
  try {
    unreadable = true;
    const [registration] = await platform.select([artifact]);

    expect(registration.selectedArtifact).toBe(artifact);
    expect(registration.status).toBe("selected");
    expect(report).toHaveBeenCalledWith(failure);
    expect(() => platform.diagnostics.get()).toThrow(failure);

    unreadable = false;
    expect(platform.diagnostics.get().registrations.get("sample")).toMatchObject({
      status: "selected",
      selectionRevision: 1,
    });
  } finally {
    unreadable = false;
    subscription[Symbol.dispose]();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});

it("preserves Core's activation outcome when diagnostics fail after setup", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({ resourceAuthority, onError: report });
  const failure = new Error("Host diagnostics failed during commit");
  let unreadable = false;
  const source = withDiagnosticReader(host, () => {
    if (unreadable) throw failure;
    return host.diagnostics.get();
  });
  const plugin = definePlugin({
    name: "sample",
    setup() {
      unreadable = true;
    },
  });
  const platform = createPlatform({
    id: "activation-diagnostic-isolation",
    host: source,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["sample", { default: plugin }]])),
    logger: { debug() {}, info() {}, warn() {}, error: report },
  });
  const registration = await select(platform, "sample", "sample");
  await host.start();
  const subscription = platform.diagnostics.subscribe(() => undefined);
  try {
    const result = await platform.activate([registration]);

    expect(result?.stateRevision).toBe(host.stateRevision);
    expect(host.installation(registration.id)).toBe(registration.installation);
    expect(registration.status).toBe("installed");
    expect(registration.error).toBeUndefined();
    expect(report).toHaveBeenCalledWith(failure);
    expect(() => platform.diagnostics.get()).toThrow(failure);

    unreadable = false;
    expect(platform.diagnostics.get().registrations.get("sample")?.status).toBe("installed");
  } finally {
    unreadable = false;
    subscription[Symbol.dispose]();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});

it("cancels admitted loading and completes disposal while a diagnostic reader is failing", async () => {
  const host = createHost({ resourceAuthority });
  const failure = new Error("Host diagnostics failed before cancellation");
  let unreadable = false;
  const source = withDiagnosticReader(host, () => {
    if (unreadable) throw failure;
    return host.diagnostics.get();
  });
  const report = vi.fn<(error: unknown) => void>();
  const entered = deferred();
  const loading = deferred<{ default: ReturnType<typeof emptyPlugin> }>();
  const platform = createPlatform({
    id: "disposal-diagnostic-isolation",
    host: source,
    apiVersion: "1.0.0",
    loader: {
      load() {
        entered.resolve();
        return loading.promise;
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error: report },
  });
  const registration = await select(platform, "sample", "sample");
  await host.start();
  const activation = platform.activate([registration]).then(
    () => "fulfilled" as const,
    (error: unknown) => error,
  );
  await entered.promise;
  const subscription = platform.diagnostics.subscribe(() => undefined);
  try {
    unreadable = true;
    const disposal = Promise.resolve().then(() => platform[Symbol.asyncDispose]());

    await expect(
      Promise.race([disposal.then(() => "disposed"), nextTurn().then(() => "pending")]),
    ).resolves.toBe("disposed");
    expect(await activation).toMatchObject({ name: "AbortError" });
    expect(platform.status).toBe("disposed");
    expect(platform.registrations()).toEqual([]);
    expect(platform.diagnostics.get().status).toBe("disposed");
    expect(report).toHaveBeenCalledWith(failure);
  } finally {
    unreadable = false;
    const cleanup = platform[Symbol.asyncDispose]();
    loading.resolve({ default: emptyPlugin("sample") });
    await activation;
    subscription[Symbol.dispose]();
    await cleanup;
    await host.stop();
  }
});
