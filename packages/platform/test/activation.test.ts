import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, service, type AnyPlugin } from "dougong";
import { createPlatform, MemoryLoader, type Platform } from "../src";
import { ActivationPlan } from "../src/activation/plan";
import { RegistrationRecord } from "../src/catalog/registration";
import { add, deferred, emptyPlugin, fixture, select, VALUE, valuePlugin } from "./fixtures";

describe("activation compilation", () => {
  it("previews metadata without authorizing, loading or running code", async () => {
    const load = vi.fn<() => void>();
    const authorize = vi.fn<() => void>();
    const host = createHost();
    const platform = createPlatform({
      id: "preview",
      host,
      apiVersion: "1.0.0",
      loader: { load },
      authorizer: { authorize },
    });
    const registration = await select(platform, "sample", "one");
    const report = platform.preview([registration]);
    expect(report.selections).toEqual([
      expect.objectContaining({
        registrationId: registration.id,
        selectionRevision: 1,
        action: "install",
      }),
    ]);
    expect(report.deferred).toEqual([
      "admission",
      "module_validation",
      "configuration_validation",
      "core_binding",
      "setup",
    ]);
    expect(report.blockers).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(host.installation(registration.id)).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it("loads a dependency closure and commits all installations once", async () => {
    const DEP = service<{ value: number }>("platform-test/dependency");
    const order: string[] = [];
    const dependency = definePlugin({
      name: "dep",
      provides: { dep: DEP },
      setup() {
        order.push("setup:dep");
        return { dep: { value: 4 } };
      },
    });
    const root = definePlugin({
      name: "root",
      requires: { dep: DEP },
      provides: { value: VALUE },
      setup({ deps }) {
        order.push("setup:root");
        return { value: { value: deps.dep.value + 1 } };
      },
    });
    const modules = new Map<string, AnyPlugin>([
      ["dep", dependency],
      ["root", root],
    ]);
    const host = createHost();
    const platform = createPlatform({
      id: "closure",
      host,
      apiVersion: "1.0.0",
      loader: {
        load(reference: string) {
          order.push("load:" + reference);
          return { default: modules.get(reference) };
        },
      },
    });
    const dep = await select(platform, "dep", "dep");
    const registration = await select(platform, "root", "root", { dependencies: { dep: "^1" } });
    await host.start();
    const before = host.stateRevision;
    await platform.activate([registration]);
    expect(host.stateRevision).toBe(before + 1);
    expect(order).toEqual(["load:dep", "load:root", "setup:dep", "setup:root"]);
    expect(await host.use(VALUE, (value) => value.value)).toBe(5);
    expect(dep.status).toBe("installed");
    expect(platform.preview([registration]).selections.map((item) => item.action)).toEqual([
      "reuse",
      "reuse",
    ]);
    await platform.activate([registration]);
    expect(host.stateRevision).toBe(before + 1);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not leave a successful dependency installed when its root fails", async () => {
    const root = definePlugin({
      name: "root",
      setup() {
        throw new Error("root failed");
      },
    });
    const { host, platform } = fixture(
      new Map([
        ["dep", emptyPlugin("dep")],
        ["root", root],
      ]),
    );
    const dep = await select(platform, "dep", "dep");
    const registration = await select(platform, "root", "root", { dependencies: { dep: "*" } });
    await host.start();
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "TRANSITION_FAILED",
    });
    expect(host.installation(dep.id)).toBeUndefined();
    expect(host.installation(registration.id)).toBeUndefined();
    expect(registration.status).toBe("failed");
    expect(registration.error).toBeDefined();
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not stop live code when loading a replacement fails", async () => {
    const { host, platform } = fixture(new Map([["one", valuePlugin("sample", 1)]]));
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    const installation = registration.installation;
    const next = add(platform, "sample", "missing", "2.0.0");
    await platform.select(next);
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "MODULE_LOAD_FAILED",
    });
    expect(registration.selectedArtifact).toBe(next);
    expect(registration.activeOrigin?.manifest.version).toBe("1.0.0");
    expect(registration.installation).toBe(installation);
    expect(await host.use(VALUE, (value) => value.value)).toBe(1);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not mark an unchanged installed dependency as failed when a new root fails", async () => {
    const root = definePlugin({
      name: "root",
      setup() {
        throw new Error("root failed");
      },
    });
    const { host, platform } = fixture(
      new Map([
        ["dep", emptyPlugin("dep")],
        ["root", root],
      ]),
    );
    const dep = await select(platform, "dep", "dep");
    const registration = await select(platform, "root", "root", { dependencies: { dep: "*" } });
    await host.start();
    await platform.activate([dep]);
    const installation = dep.installation;
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "TRANSITION_FAILED",
    });
    expect(dep.installation).toBe(installation);
    expect(dep.status).toBe("installed");
    expect(dep.error).toBeUndefined();
    expect(registration.status).toBe("failed");
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("keeps a failed selected update while Core restores the previous implementation", async () => {
    const broken = definePlugin({
      name: "sample",
      provides: { value: VALUE },
      setup() {
        throw new Error("new setup failed");
      },
    });
    const { host, platform } = fixture(
      new Map([
        ["one", valuePlugin("sample", 1)],
        ["two", broken],
      ]),
    );
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    const installation = registration.installation;
    const next = add(platform, "sample", "two", "2.0.0");
    await platform.select(next);
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "TRANSITION_FAILED",
    });
    expect(registration.selectedArtifact.manifest.version).toBe("2.0.0");
    expect(registration.activeOrigin?.manifest.version).toBe("1.0.0");
    expect(registration.installation).toBe(installation);
    expect(await host.use(VALUE, (value) => value.value)).toBe(1);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("projects committed source data even before Platform's Host subscriber runs", async () => {
    const host = createHost();
    let platform: Platform<string>;
    const observations: Array<{ committed: unknown; projected: unknown }> = [];
    host.diagnostics.subscribe(() => {
      const registration = platform?.diagnostics.get().registrations.get("sample");
      if (registration) {
        observations.push({
          committed: host.installation(registration.id)?.origin?.revision,
          projected: registration.activeOrigin?.revision,
        });
      }
    });
    platform = createPlatform({
      id: "observe",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(
        new Map([
          ["one", { default: valuePlugin("sample", 1) }],
          ["two", { default: valuePlugin("sample", 2) }],
        ]),
      ),
    });
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    await platform.select(add(platform, "sample", "two", "2.0.0"));
    await platform.activate([registration]);
    expect(registration.activeOrigin?.manifest.version).toBe("2.0.0");
    expect(observations.some((item) => item.committed === "2.0.0")).toBe(true);
    expect(observations.every((item) => item.committed === item.projected)).toBe(true);
    expect(await host.use(VALUE, (value) => value.value)).toBe(2);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("validates the final manifest dependency graph for batch version upgrades", async () => {
    const modules = new Map([
      ["dep1", emptyPlugin("dep")],
      ["dep2", emptyPlugin("dep")],
      ["consumer1", emptyPlugin("consumer")],
      ["consumer2", emptyPlugin("consumer")],
    ]);
    const { host, platform } = fixture(modules);
    const dep = await select(platform, "dep", "dep1");
    const consumer = await select(platform, "consumer", "consumer1", {
      dependencies: { dep: "^1" },
    });
    await host.start();
    await platform.activate([consumer]);
    await platform.select(add(platform, "dep", "dep2", "2.0.0"));
    expect(platform.preview([dep]).blockers[0]?.code).toBe("REGISTRATION_DEPENDENCY_INCOMPATIBLE");
    await expect(platform.activate([dep])).rejects.toMatchObject({
      code: "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
    });
    await platform.select(
      add(platform, "consumer", "consumer2", "2.0.0", {
        manifest: { name: "consumer", version: "2.0.0", dependencies: { dep: "^2" } },
      }),
    );
    const before = host.stateRevision;
    await platform.activate([consumer]);
    expect(host.stateRevision).toBe(before + 1);
    expect(dep.activeOrigin?.manifest.version).toBe("2.0.0");
    expect(consumer.activeOrigin?.manifest.version).toBe("2.0.0");
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("compiles removals and new providers into one valid Core plan", async () => {
    const { host, platform } = fixture(
      new Map([
        ["old", valuePlugin("old", 1)],
        ["new", valuePlugin("new", 2)],
      ]),
    );
    const old = await select(platform, "old", "old");
    const next = await select(platform, "new", "new");
    await host.start();
    await platform.activate([old]);
    const before = host.stateRevision;
    const preview = platform.preview([next], { remove: [old] });
    expect(preview.removals).toEqual([{ registrationId: old.id, selectionRevision: 1 }]);
    await platform.activate([next], { remove: [old] });
    expect(host.stateRevision).toBe(before + 1);
    expect(old.status).toBe("removed");
    expect(await host.use(VALUE, (value) => value.value)).toBe(2);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });

  it("preflights contradictory closure removals before loading", async () => {
    const load = vi.fn<() => void>();
    const platform = createPlatform({
      id: "contradiction",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: { load },
    });
    const dep = await select(platform, "dep", "dep");
    const consumer = await select(platform, "consumer", "consumer", { dependencies: { dep: "*" } });
    await expect(platform.activate([consumer], { remove: [dep] })).rejects.toMatchObject({
      code: "REGISTRATION_DEPENDENCY_MISSING",
      details: {
        outcome: "rejected",
        phase: "artifact_planning",
        dependencyPath: ["consumer", "dep"],
      },
    });
    expect(load).not.toHaveBeenCalled();
    expect(dep.status).toBe("selected");
    await platform[Symbol.asyncDispose]();
  });

  it("returns all structural blockers in a data-only preview", async () => {
    const { platform } = fixture();
    const registration = await select(platform, "root", "root", {
      dependencies: { absent: "*", other: "*" },
    });
    const report = platform.preview([registration]);
    expect(report.blockers.map((item) => item.dependencyPath)).toEqual([
      ["root", "absent"],
      ["root", "other"],
    ]);
    await expect(platform.activate([registration])).rejects.toBeInstanceOf(AggregateError);
    await platform[Symbol.asyncDispose]();
  });

  it("reports selected closure and unchanged consumer blockers together", async () => {
    const { platform } = fixture(
      new Map([
        ["dep", emptyPlugin("dep")],
        ["consumer", emptyPlugin("consumer")],
      ]),
    );
    const dependency = await select(platform, "dep", "dep");
    const consumer = await select(platform, "consumer", "consumer", {
      dependencies: { dep: "^1" },
    });
    await platform.activate([consumer]);
    await platform.select(add(platform, "dep", "dep", "2.0.0"));
    const next = await select(platform, "next", "next", { dependencies: { absent: "*" } });
    const report = platform.preview([dependency, next]);
    expect(report.blockers.map((item) => item.code)).toEqual([
      "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
      "REGISTRATION_DEPENDENCY_MISSING",
    ]);
    expect(platform.preview([next], { remove: [next] }).blockers).toEqual([
      expect.objectContaining({
        code: "REGISTRATION_DEPENDENCY_MISSING",
        dependencyPath: ["next"],
      }),
    ]);
    await platform[Symbol.asyncDispose]();
  });

  it("rejects cycles and incompatible selected dependencies before module evaluation", async () => {
    const { platform } = fixture();
    const one = await select(platform, "one", "one", { dependencies: { two: "^2" } });
    await select(platform, "two", "two", { dependencies: { one: "*" } });
    const codes = platform.preview([one]).blockers.map((item) => item.code);
    expect(codes).toContain("REGISTRATION_CYCLE");
    expect(codes).toContain("REGISTRATION_DEPENDENCY_INCOMPATIBLE");
    await platform[Symbol.asyncDispose]();
  });

  it("checks the concrete root again after awaiting a dependency Loader", async () => {
    const entered = deferred();
    const release = deferred();
    const loaded: string[] = [];
    let allowed = true;
    const host = createHost();
    const platform = createPlatform({
      id: "admission",
      host,
      apiVersion: "1.0.0",
      authorizer: {
        authorize({ artifact }) {
          if (artifact.manifest.name === "root" && !allowed) throw new Error("revoked");
        },
      },
      loader: {
        async load(reference: string) {
          loaded.push(reference);
          if (reference === "dep") {
            entered.resolve();
            await release.promise;
          }
          return { default: emptyPlugin(reference) };
        },
      },
    });
    const dep = await select(platform, "dep", "dep");
    const root = await select(platform, "root", "root", { dependencies: { dep: "*" } });
    const activation = platform.activate([root]);
    await entered.promise;
    allowed = false;
    release.resolve();
    await expect(activation).rejects.toThrow("revoked");
    expect(loaded).toEqual(["dep"]);
    expect(host.installation(dep.id)).toBeUndefined();
    expect(host.installation(root.id)).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it("reauthorizes cached code before a new generation is committed", async () => {
    const plugin = emptyPlugin("sample");
    const load = vi.fn<() => { default: typeof plugin }>(() => ({ default: plugin }));
    const host = createHost();
    let allowActivation = false;
    const operations: string[] = [];
    const platform = createPlatform({
      id: "policy",
      host,
      apiVersion: "1.0.0",
      loader: { load },
      authorizer: {
        authorize(request) {
          operations.push(request.operation);
          if (request.operation === "activate" && !allowActivation)
            throw new Error("activation denied");
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    await expect(platform.activate([registration])).rejects.toThrow("activation denied");
    expect(host.installation(registration.id)).toBeUndefined();
    allowActivation = true;
    await platform.activate([registration]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(operations).toEqual(["load", "activate", "activate"]);
    await platform[Symbol.asyncDispose]();
  });

  it.each([
    null,
    5,
    {},
    { default: {} },
    {
      get default() {
        throw new Error("getter");
      },
    },
  ])("rejects invalid module boundaries", async (module) => {
    const host = createHost();
    const platform = createPlatform({
      id: "invalid-module",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["one", module]])),
    });
    const registration = await select(platform, "sample", "one");
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "MODULE_INVALID",
    });
    expect(host.installation(registration.id)).toBeUndefined();
    await platform[Symbol.asyncDispose]();
  });

  it("rejects a valid Plugin with a different authorized identity", async () => {
    const { platform } = fixture(new Map([["one", emptyPlugin("other")]]));
    const registration = await select(platform, "sample", "one");
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY",
    });
    await platform[Symbol.asyncDispose]();
  });

  it("preserves Loader failure causes and keeps diagnostics serializable", async () => {
    const reason = { privateResource: () => undefined };
    const platform = createPlatform({
      id: "failure",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: {
        load() {
          throw reason;
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "MODULE_LOAD_FAILED",
      cause: reason,
    });
    expect(registration.error?.snapshot).not.toHaveProperty("privateResource");
    expect(JSON.stringify(registration.error?.snapshot)).not.toContain("privateResource");
    await platform[Symbol.asyncDispose]();
  });

  it("preserves an inaccessible authorization rejection without retaining it in diagnostics", async () => {
    const reason = Proxy.revocable({}, {});
    reason.revoke();
    const platform = createPlatform({
      id: "admission-failure",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
      authorizer: {
        authorize() {
          throw reason.proxy;
        },
      },
    });
    const registration = await select(platform, "sample", "unused");
    const failure: unknown = await platform
      .activate([registration])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
    expect((failure as { code: string }).code).toBe("ACTIVATION_FAILED");
    expect(registration.status).toBe("failed");
    expect(registration.error?.snapshot).toMatchObject({ code: "ACTIVATION_FAILED" });
    await platform[Symbol.asyncDispose]();
  });
});

it("plans deep delivery closures without consuming the JS call stack or copying every ancestor path", () => {
  const records = new Map<string, RegistrationRecord<string>>();
  const count = 9000;
  for (let i = 0; i < count; i++) {
    const name = String(i);
    records.set(
      name,
      new RegistrationRecord(
        "deep",
        {
          revision: "one",
          config: undefined,
          reference: name,
          manifest: {
            name,
            version: "1.0.0",
            apiVersion: "*",
            activation: [],
            permissions: [],
            dependencies: i + 1 === count ? {} : { [String(i + 1)]: "*" },
          },
        },
        { installation: () => undefined, operation: () => undefined },
      ),
    );
  }
  const root = records.get("0")!;
  const plan = new ActivationPlan(records, [root]);
  expect(plan.report.blockers).toEqual([]);
  expect(plan.selections).toHaveLength(count);
  expect(plan.selections[0]?.registration.name).toBe(String(count - 1));
  expect(plan.selections.at(-1)?.registration).toBe(root);
  const last = records.get(String(count - 1))!;
  const artifact = last.selectedArtifact;
  last.select({
    ...artifact,
    manifest: { ...artifact.manifest, dependencies: { [String(count - 2)]: "*" } },
  });
  expect(new ActivationPlan(records, [root]).report.blockers[0]?.dependencyPath).toEqual(
    [count - 1, count - 2, count - 1].map(String),
  );
});
