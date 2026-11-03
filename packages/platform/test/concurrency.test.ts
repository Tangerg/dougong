import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, type AnyPlugin } from "dougong";
import { createPlatform } from "../src";
import {
  add,
  deferred,
  emptyPlugin,
  fixture,
  nextTurn,
  select,
  VALUE,
  valuePlugin,
} from "./fixtures";

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
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(2);
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
          if (reference === "dependency") {
            entered.resolve();
            await release.promise;
            signal.throwIfAborted();
          }
          return { default: emptyPlugin(reference) };
        },
      },
    });
    const dependency = await select(platform, "dependency", "dependency");
    const first = await select(platform, "first", "first", { dependencies: { dependency: "*" } });
    const second = await select(platform, "second", "second", {
      dependencies: { dependency: "*" },
    });
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
    expect(loaded.filter((reference) => reference === "dependency")).toHaveLength(1);
    expect(dependency.status).toBe("installed");
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

  it("refuses a new choice while the final activation can call user code", async () => {
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
    const next = add(platform, "sample", "new", "2.0.0");
    await expect(platform.select(next)).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
    expect(registration.selectedArtifact.revision).toBe("1.0.0");
    release.resolve();
    await activation;
    await platform.select(next);
    expect(registration.selectedArtifact.revision).toBe("2.0.0");
    expect(registration.activeOrigin?.revision).toBe("1.0.0");
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(1);
    await platform.activate([registration]);
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(2);
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
      ["dependency", emptyPlugin("dependency")],
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
    const dependency = await select(platform, "dependency", "dependency");
    const root = await select(platform, "root", "root", { dependencies: { dependency: "*" } });
    await platform.activate([dependency]);
    const activation = platform.activate([root]);
    const result = activation.catch((error: unknown) => error);
    await entered.promise;
    const change = host.change();
    change.update(dependency.installation!, { plugin: emptyPlugin("dependency") });
    await host.apply(await host.plan(change));
    gate.resolve();
    expect(await result).toMatchObject({ code: "ACTIVATION_STALE" });
    expect(dependency.activeOrigin).toBeUndefined();
    await platform.activate([root]);
    expect(dependency.activeOrigin?.revision).toBe("1.0.0");
    await platform[Symbol.asyncDispose]();
  });
});

it.each([true, false])(
  "derives trigger roots from the selection admitted before it (next matches: %s)",
  async (matches) => {
    const { host, platform } = fixture(new Map([["module", emptyPlugin("sample")]]));
    const first = await select(platform, "sample", "module", {
      activation: matches ? [] : ["open"],
    });
    const replacement = add(platform, "sample", "module", "2.0.0", {
      manifest: { name: "sample", version: "2.0.0", activation: matches ? ["open"] : [] },
    });
    await Promise.all([platform.select(replacement), platform.trigger("open")]);
    expect(first.activeOrigin?.revision).toBe(matches ? "2.0.0" : undefined);
    expect(host.installation(first.id)).toBe(matches ? first.installation : undefined);
    await platform[Symbol.asyncDispose]();
  },
);

it("withdraws a loaded activation while another activation owns the Core handoff", async () => {
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  const loading = deferred();
  const releaseLoader = deferred();
  const platform = createPlatform({
    id: "handoff",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: {
      async load(name: string) {
        if (name === "queued") {
          loading.resolve();
          await releaseLoader.promise;
        }
        return { default: emptyPlugin(name) };
      },
    },
    authorizer: {
      async authorize({ operation, artifact }) {
        if (operation === "activate" && artifact.manifest.name === "first") {
          admissionEntered.resolve();
          await releaseAdmission.promise;
        }
      },
    },
  });
  const queued = await select(platform, "queued", "queued");
  const first = await select(platform, "first", "first");
  const controller = new AbortController();
  const attempt = platform
    .activate([queued], { signal: controller.signal })
    .catch((reason: unknown) => reason);
  await loading.promise;
  const applying = platform.activate([first]);
  await admissionEntered.promise;
  releaseLoader.resolve();
  await nextTurn();
  controller.abort("withdrawn");
  try {
    expect(await Promise.race([attempt, nextTurn().then(() => "blocked")])).toBe("withdrawn");
    expect(queued.status).toBe("selected");
  } finally {
    releaseAdmission.resolve();
    await applying;
    await attempt;
    expect(queued.installation).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  }
});

it.each(["select", "remove", "dispose"] as const)(
  "commits the full %s projection before calling a superseded loader's cancellation handler",
  async (command) => {
    const entered = deferred();
    const blocked = deferred<never>();
    const observed: unknown[] = [];
    const platform = createPlatform({
      id: "projection",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: {
        load(_reference: string, signal: AbortSignal) {
          signal.addEventListener("abort", () => {
            const snapshot = platform.diagnostics.get();
            observed.push({
              status: snapshot.status,
              live: platform
                .registrations()
                .map((registration) => registration.selectedArtifact.revision),
              projected: [...snapshot.registrations.values()].map(
                (registration) => registration.selectedArtifact.revision,
              ),
            });
          });
          entered.resolve();
          return blocked.promise;
        },
      },
    });
    const first = await select(platform, "a", "a");
    const second = await select(platform, "b", "b");
    const attempt = platform.activate([first]).catch((error: unknown) => error);
    try {
      await entered.promise;
      if (command === "select") await platform.select(add(platform, "a", "updated", "2.0.0"));
      else if (command === "remove") await platform.remove(first, second);
      else await platform[Symbol.asyncDispose]();
      await attempt;
      const revisions =
        command === "remove" ? [] : [command === "select" ? "2.0.0" : "1.0.0", "1.0.0"];
      expect(observed).toEqual([
        {
          status: command === "dispose" ? "disposing" : "active",
          live: revisions,
          projected: revisions,
        },
      ]);
    } finally {
      blocked.reject(new Error("loader finished late"));
      await platform[Symbol.asyncDispose]();
    }
  },
);

it.each(["revision", "quarantine"] as const)(
  "releases obsolete final admission on Host %s",
  async (change) => {
    const entered = deferred<AbortSignal>();
    const release = deferred();
    const native = definePlugin({
      name: "native",
      setup({ lifetime }) {
        if (change === "quarantine")
          lifetime.defer(() => {
            throw new Error("cleanup failed");
          });
      },
    });
    const host = createHost({ installations: [{ id: "native", plugin: native }] });
    await host.start();
    let hold = true;
    const platform = createPlatform({
      id: "stale-admission",
      host,
      apiVersion: "1.0.0",
      loader: { load: (reference: string) => ({ default: emptyPlugin(reference) }) },
      authorizer: {
        authorize({ operation }, signal) {
          if (operation === "activate" && hold) {
            entered.resolve(signal);
            return release.promise;
          }
          return undefined;
        },
      },
    });
    const target = await select(platform, "sample", "sample");
    const before = host.stateRevision;
    const attempt = platform.activate([target]).catch((error: unknown) => error);
    const signal = await entered.promise;
    try {
      const stop = await host.stop().catch((error: unknown) => error);
      expect(stop).toMatchObject(
        change === "quarantine"
          ? { code: "HOST_QUARANTINED" }
          : { stateRevision: host.stateRevision },
      );
      const failure = await Promise.race([attempt, nextTurn().then(() => "still reserved")]);
      expect(failure).toMatchObject(
        change === "quarantine"
          ? { code: "PLATFORM_UNAVAILABLE", details: { stateRevision: host.stateRevision } }
          : {
              code: "ACTIVATION_STALE",
              details: { expectedRevision: before, stateRevision: host.stateRevision },
            },
      );
      expect(signal.aborted).toBe(true);
      expect(target.installation).toBeUndefined();
      hold = false;
      const retry = await platform.activate([target]).catch((error: unknown) => error);
      expect(retry).toMatchObject(
        change === "quarantine"
          ? { code: "PLATFORM_UNAVAILABLE" }
          : { affectedInstallations: [target.id] },
      );
    } finally {
      release.resolve();
      await attempt;
      await platform[Symbol.asyncDispose]();
    }
  },
);
