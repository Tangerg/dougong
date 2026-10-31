import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, type AnyPlugin } from "dougong";
import { createPlatform } from "../src";
import { add, deferred, emptyPlugin, nextTurn, select, VALUE, valuePlugin } from "./fixtures";

describe("selection and activation races", () => {
  it("rejects a late old selection even when the Host revision has not changed", async () => {
    const entered = deferred();
    const release = deferred();
    const host = createHost();
    const platform = createPlatform({
      id: "selection",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load(reference: string) {
          if (reference === "old") {
            entered.resolve();
            await release.promise;
          }
          return { default: valuePlugin("sample", reference === "old" ? 1 : 2) };
        },
      },
    });
    const registration = await select(platform, "sample", "old");
    await host.start();
    const before = host.stateRevision;
    const first = platform.activate([registration]);
    const firstResult = first.catch((error: unknown) => error);
    await entered.promise;
    await platform.select(add(platform, "sample", "new", "2.0.0"));
    expect(host.stateRevision).toBe(before);
    expect(await firstResult).toMatchObject({ code: "SELECTION_SUPERSEDED" });
    await platform.activate([registration]);
    release.resolve();
    await nextTurn();
    expect(await host.use(VALUE, (value) => value.value)).toBe(2);
    expect(registration.activeOrigin?.revision).toBe("2.0.0");
    expect(registration.error).toBeUndefined();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not cancel another activation's shared dependency load", async () => {
    const entered = deferred();
    const release = deferred();
    const loaded: string[] = [];
    const host = createHost();
    const platform = createPlatform({
      id: "sharing",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load(reference: string, signal: AbortSignal) {
          loaded.push(reference);
          if (reference === "dep") {
            entered.resolve();
            await release.promise;
            signal.throwIfAborted();
          }
          return { default: emptyPlugin(reference) };
        },
      },
    });
    const dep = await select(platform, "dep", "dep");
    const first = await select(platform, "first", "first", { dependencies: { dep: "*" } });
    const second = await select(platform, "second", "second", { dependencies: { dep: "*" } });
    const controller = new AbortController();
    const firstRun = platform.activate([first], { signal: controller.signal });
    const firstResult = firstRun.catch((error: unknown) => error);
    await entered.promise;
    const secondRun = platform.activate([second]);
    await nextTurn();
    controller.abort();
    expect(await firstResult).toBe(controller.signal.reason);
    release.resolve();
    await secondRun;
    expect(loaded.filter((reference) => reference === "dep")).toHaveLength(1);
    expect(dep.status).toBe("installed");
    expect(second.status).toBe("installed");
    expect(host.installation(first.id)).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it("coalesces concurrent requests without constructing duplicate generations", async () => {
    const entered = deferred();
    const release = deferred();
    const setup = vi.fn<() => void>(() => undefined);
    const host = createHost();
    const load = vi.fn<() => Promise<{ default: AnyPlugin }>>(async () => {
      entered.resolve();
      await release.promise;
      return { default: definePlugin({ name: "sample", setup }) };
    });
    const platform = createPlatform({
      id: "concurrent",
      host,
      apiVersion: "1.0.0",
      loader: { load },
    });
    const registration = await select(platform, "sample", "one");
    await host.start();
    const first = platform.activate([registration]);
    await entered.promise;
    const second = platform.activate([registration]);
    await nextTurn();
    release.resolve();
    await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledTimes(1);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("can retry immediately after the only waiter cancels a non-cooperative load", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const host = createHost();
    const platform = createPlatform({
      id: "retry",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load() {
          if (++calls === 1) {
            entered.resolve();
            await release.promise;
          }
          return { default: emptyPlugin("sample") };
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    const controller = new AbortController();
    const first = platform
      .activate([registration], { signal: controller.signal })
      .catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    expect(await first).toBe(controller.signal.reason);
    await platform.activate([registration]);
    expect(calls).toBe(2);
    expect(registration.status).toBe("installed");
    release.resolve();
    await nextTurn();
    expect(registration.activeOrigin?.revision).toBe("1.0.0");
    await platform[Symbol.asyncDispose]();
  });

  it("serializes a new choice behind a final activation commit", async () => {
    const entered = deferred();
    const release = deferred();
    const old = definePlugin({
      name: "sample",
      provides: { value: VALUE },
      async setup() {
        entered.resolve();
        await release.promise;
        return { value: { value: 1 } };
      },
    });
    const host = createHost();
    const platform = createPlatform({
      id: "commit",
      host,
      apiVersion: "1.0.0",
      loader: {
        load(reference: string) {
          return { default: reference === "old" ? old : valuePlugin("sample", 2) };
        },
      },
    });
    const registration = await select(platform, "sample", "old");
    await host.start();
    const activation = platform.activate([registration]);
    await entered.promise;
    const selection = platform.select(add(platform, "sample", "new", "2.0.0"));
    expect(registration.selectedArtifact.revision).toBe("1.0.0");
    release.resolve();
    await activation;
    await selection;
    expect(registration.selectedArtifact.revision).toBe("2.0.0");
    expect(registration.activeOrigin?.revision).toBe("1.0.0");
    expect(await host.use(VALUE, (value) => value.value)).toBe(1);
    await platform.activate([registration]);
    expect(await host.use(VALUE, (value) => value.value)).toBe(2);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("reports a committed result when cancellation arrives after Core execution starts", async () => {
    const entered = deferred();
    const release = deferred();
    const plugin = definePlugin({
      name: "sample",
      async setup() {
        entered.resolve();
        await release.promise;
      },
    });
    const host = createHost();
    const platform = createPlatform({
      id: "late-cancel",
      host,
      apiVersion: "1.0.0",
      loader: {
        load() {
          return { default: plugin };
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    const controller = new AbortController();
    await host.start();
    const activation = platform.activate([registration], { signal: controller.signal });
    await entered.promise;
    controller.abort();
    release.resolve();
    expect(await activation).toEqual({
      stateRevision: host.stateRevision,
      affectedInstallations: [registration.installation!.id],
    });
    expect(registration.status).toBe("installed");
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("cancels loading before removal and never commits a late module", async () => {
    const entered = deferred();
    const release = deferred();
    const setup = vi.fn<() => void>();
    const host = createHost();
    const platform = createPlatform({
      id: "remove-load",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load() {
          entered.resolve();
          await release.promise;
          return { default: definePlugin({ name: "sample", setup }) };
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    const activation = platform.activate([registration]).catch((error: unknown) => error);
    await entered.promise;
    await platform.remove(registration);
    expect(await activation).toMatchObject({ code: "SELECTION_SUPERSEDED" });
    release.resolve();
    await nextTurn();
    expect(registration.status).toBe("removed");
    expect(host.installation(registration.id)).toBeUndefined();
    expect(setup).not.toHaveBeenCalled();
    await platform[Symbol.asyncDispose]();
  });

  it("cancels before admission if a loading observer disposes the Platform", async () => {
    const authorize = vi.fn<() => void>();
    const load = vi.fn<() => void>();
    const host = createHost();
    const platform = createPlatform({
      id: "observer-cancel",
      host,
      apiVersion: "1.0.0",
      loader: { load },
      authorizer: { authorize },
    });
    const registration = await select(platform, "sample", "one");
    let disposal: Promise<void> | undefined;
    platform.diagnostics.subscribe(() => {
      if (registration.status === "activating") disposal = platform[Symbol.asyncDispose]();
    });
    await expect(platform.activate([registration])).rejects.toMatchObject({ name: "AbortError" });
    await disposal;
    expect(authorize).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(platform.status).toBe("disposed");
  });

  it("rejects a removed selection handle without touching its replacement", async () => {
    const host = createHost();
    const platform = createPlatform({
      id: "identity",
      host,
      apiVersion: "1.0.0",
      loader: {
        load() {
          return { default: emptyPlugin("sample") };
        },
      },
    });
    const artifact = add(platform, "sample", "one");
    const first = await platform.select(artifact);
    await platform.remove(first);
    const second = await platform.select(artifact);
    expect(second).not.toBe(first);
    await expect(platform.remove(first)).rejects.toMatchObject({
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(second.status).toBe("selected");
    await platform.activate([second]);
    await platform[Symbol.asyncDispose]();
  });

  it("does not silently reload code when Core state changes after a reuse preview", async () => {
    const gate = deferred();
    const entered = deferred();
    const host = createHost();
    const modules = new Map<string, AnyPlugin>([
      ["dep", emptyPlugin("dep")],
      ["root", emptyPlugin("root")],
    ]);
    const platform = createPlatform({
      id: "core-change",
      host,
      apiVersion: "1.0.0",
      loader: {
        async load(reference: string) {
          if (reference === "root") {
            entered.resolve();
            await gate.promise;
          }
          return { default: modules.get(reference) };
        },
      },
    });
    const dep = await select(platform, "dep", "dep");
    const root = await select(platform, "root", "root", { dependencies: { dep: "*" } });
    await platform.activate([dep]);
    const activation = platform.activate([root]);
    const result = activation.catch((error: unknown) => error);
    await entered.promise;
    const change = host.change();
    change.update(dep.installation!, { plugin: emptyPlugin("dep") });
    await host.apply(await host.plan(change));
    gate.resolve();
    expect(await result).toMatchObject({ code: "ACTIVATION_STALE" });
    expect(dep.activeOrigin).toBeUndefined();
    await platform.activate([root]);
    expect(dep.activeOrigin?.revision).toBe("1.0.0");
    await platform[Symbol.asyncDispose]();
  });
});
