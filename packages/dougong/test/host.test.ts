import { describe, expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  service,
  optional,
  extensionPoint,
  event,
  type Host,
  type AnyPlugin,
  type Service,
  type PluginContext,
  type Logger,
} from "../src/index";

const value = service<number>("host/value");
const output = service<number>("host/output");
const provider = (number: number, setup?: () => void) =>
  definePlugin({
    name: "provider",
    provides: { value },
    setup() {
      setup?.();
      return { value: number };
    },
  });
async function replace(host: Host, id: string, plugin: AnyPlugin) {
  const change = host.change();
  change.update(host.installation(id)!, { plugin });
  return host.apply(await host.plan(change));
}
async function read<T>(host: Host, token: Service<T>) {
  return host.use(token, (item) => item);
}

describe("Host execution", () => {
  it("constructs inert declarations, starts in dependency order and stops in reverse", async () => {
    const steps: string[] = [];
    const a = definePlugin({
      name: "a",
      provides: { value },
      setup({ lifetime }) {
        steps.push("a");
        lifetime.defer(() => {
          steps.push("-a");
        });
        return { value: 4 };
      },
    });
    const b = definePlugin({
      name: "b",
      requires: { value },
      provides: { output },
      setup({ deps, lifetime }) {
        steps.push("b");
        lifetime.defer(() => {
          steps.push("-b");
        });
        return { output: deps.value * 2 };
      },
    });
    const host = createHost({
      installations: [
        { id: "b", plugin: b },
        { id: "a", plugin: a },
      ],
    });
    expect(steps).toEqual([]);
    expect(host.status).toBe("stopped");
    await expect(read(host, output)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await host.start();
    expect(await read(host, output)).toBe(8);
    expect(steps).toEqual(["a", "b"]);
    await host.stop();
    expect(steps).toEqual(["a", "b", "-b", "-a"]);
    expect(host.installation("a")?.status).toBe("stopped");
    expect(host.diagnostics.get().installations).toHaveLength(2);
    const revision = host.stateRevision;
    await host.stop();
    expect(host.stateRevision).toBe(revision);
    await host.start();
    const running = host.stateRevision;
    await host.start();
    expect(host.stateRevision).toBe(running);
    await host[Symbol.asyncDispose]();
  });

  it("prepares independent providers concurrently", async () => {
    const gate = Promise.withResolvers<void>();
    let entered = 0;
    const make = (name: string) =>
      definePlugin({
        name,
        async setup() {
          entered++;
          await gate.promise;
        },
      });
    const host = createHost({
      installations: [
        { id: "a", plugin: make("a") },
        { id: "b", plugin: make("b") },
      ],
    });
    const starting = host.start();
    await vi.waitFor(() => expect(entered).toBe(2));
    gate.resolve();
    await starting;
    await host.stop();
  });

  it("cancels and joins sibling preparation after a failure", async () => {
    const entered = Promise.withResolvers<void>();
    const completed = vi.fn<() => void>();
    const host = createHost({
      installations: [
        {
          id: "waiter",
          plugin: definePlugin({
            name: "waiter",
            async setup({ lifetime }) {
              entered.resolve();
              await new Promise<void>((resolve) =>
                lifetime.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
              completed();
            },
          }),
        },
        {
          id: "failure",
          plugin: definePlugin({
            name: "failure",
            async setup() {
              await entered.promise;
              throw new Error("broken");
            },
          }),
        },
      ],
    });
    await expect(host.start()).rejects.toMatchObject({ details: { outcome: "restored" } });
    expect(completed).toHaveBeenCalledOnce();
    expect(host.status).toBe("stopped");
  });

  it("allows dependency aliases that match framework capability names", async () => {
    const consumer = definePlugin({
      name: "consumer",
      requires: { lifetime: value },
      provides: { output },
      setup({ deps, lifetime }) {
        expect(lifetime.signal.aborted).toBe(false);
        return { output: deps.lifetime };
      },
    });
    const host = createHost({
      installations: [
        { id: "provider", plugin: provider(3) },
        { id: "consumer", plugin: consumer },
      ],
    });
    await host.start();
    expect(await read(host, output)).toBe(3);
    await host.stop();
  });

  it("rebuilds only changed providers and their transitive consumers", async () => {
    const count = { provider: 0, consumer: 0, other: 0 };
    const consumer = definePlugin({
      name: "consumer",
      requires: { value },
      provides: { output },
      setup({ deps }) {
        count.consumer++;
        return { output: deps.value + 1 };
      },
    });
    const other = definePlugin({
      name: "other",
      setup() {
        count.other++;
      },
    });
    const host = createHost({
      installations: [
        { id: "provider", plugin: provider(1, () => count.provider++) },
        { id: "consumer", plugin: consumer },
        { id: "other", plugin: other },
      ],
    });
    await host.start();
    const change = host.change();
    change.update(host.installation("provider")!, { plugin: provider(2, () => count.provider++) });
    const plan = await host.plan(change);
    expect(plan.report.affectedInstallations).toEqual(["provider", "consumer"]);
    expect(plan.report.reasons).toContainEqual({
      installation: "consumer",
      kind: "provider_changed",
      contract: value.id,
      provider: "provider",
      previousProvider: "provider",
    });
    expect(host.explain("consumer")).toEqual([
      { installation: "consumer", contract: value.id, optional: false, provider: "provider" },
    ]);
    await host.apply(plan);
    expect(count).toEqual({ provider: 2, consumer: 2, other: 1 });
    expect(await read(host, output)).toBe(3);
    await host.stop();
  });

  it("rebinds optional dependencies on provider appearance and removal", async () => {
    const consumer = definePlugin({
      name: "optional",
      requires: { value: optional(value) },
      provides: { output },
      setup({ deps }) {
        return { output: deps.value ?? 0 };
      },
    });
    const host = createHost({ installations: [{ id: "consumer", plugin: consumer }] });
    await host.start();
    expect(await read(host, output)).toBe(0);
    const add = host.change();
    const installed = add.install(provider(5), { id: "provider" });
    await host.apply(await host.plan(add));
    expect(await read(host, output)).toBe(5);
    const remove = host.change();
    remove.remove(installed);
    await host.apply(await host.plan(remove));
    expect(await read(host, output)).toBe(0);
    expect(await host.use(optional(value), (v) => v)).toBeUndefined();
    expect(installed.status).toBe("removed");
    await host.stop();
  });

  it("rejects conflicts, missing providers, cycles and cross-kind identities before setup", async () => {
    const setup = vi.fn<() => void>();
    const missing = definePlugin({ name: "missing", requires: { value }, setup });
    expect(() => createHost({ installations: [{ id: "missing", plugin: missing }] })).toThrowError(
      expect.objectContaining({ code: "SERVICE_MISSING" }),
    );
    expect(() =>
      createHost({
        installations: [
          { id: "a", plugin: provider(1) },
          { id: "b", plugin: provider(2) },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVICE_CONFLICT" }));
    const a = definePlugin({
      name: "a",
      requires: { output },
      provides: { value },
      setup: () => ({ value: 1 }),
    });
    const b = definePlugin({
      name: "b",
      requires: { value },
      provides: { output },
      setup: () => ({ output: 1 }),
    });
    expect(() =>
      createHost({
        installations: [
          { id: "a", plugin: a },
          { id: "b", plugin: b },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVICE_CYCLE" }));
    const host = createHost();
    host.contributions(extensionPoint(value.id));
    const change = host.change();
    change.install(provider(1), { id: "a" });
    await expect(host.plan(change)).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
    expect(setup).not.toHaveBeenCalled();
  });

  it("publishes a whole multi-layer candidate only after every setup succeeds", async () => {
    const ping = event<void>("host/ping");
    const sender = service<{ send(): Promise<void> }>("host/sender");
    const received = vi.fn<() => void>();
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const emitter = definePlugin({
      name: "emitter",
      provides: { sender },
      setup({ events }) {
        return { sender: { send: () => events.emit(ping, undefined) } };
      },
    });
    const host = createHost({ installations: [{ id: "emitter", plugin: emitter }] });
    await host.start();
    const change = host.change();
    change.install(
      definePlugin({
        name: "first",
        provides: { value },
        setup({ events }) {
          events.on(ping, received);
          return { value: 1 };
        },
      }),
      { id: "first" },
    );
    change.install(
      definePlugin({
        name: "later",
        requires: { value },
        async setup() {
          entered.resolve();
          await gate.promise;
        },
      }),
      { id: "later" },
    );
    const applying = host.apply(await host.plan(change));
    await entered.promise;
    await host.use(sender, (service) => service.send());
    expect(received).not.toHaveBeenCalled();
    gate.reject(new Error("later failed"));
    await expect(applying).rejects.toMatchObject({ details: { outcome: "restored" } });
    await host.use(sender, (service) => service.send());
    expect(received).not.toHaveBeenCalled();
    expect(host.installation("first")).toBeUndefined();
    await host.stop();
  });

  it("rejects preparation-time event emission", async () => {
    const ping = event<void>("host/preparing");
    const host = createHost({
      installations: [
        {
          id: "a",
          plugin: definePlugin({ name: "a", setup: ({ events }) => events.emit(ping, undefined) }),
        },
      ],
    });
    await expect(host.start()).rejects.toMatchObject({ details: { outcome: "restored" } });
    expect(host.status).toBe("stopped");
  });

  it("returns Busy without changing or consuming an approved plan", async () => {
    const host = createHost({ installations: [{ id: "a", plugin: provider(1) }] });
    await host.start();
    const entered = Promise.withResolvers<void>(),
      exit = Promise.withResolvers<void>();
    const using = host.use(value, async () => {
      entered.resolve();
      await exit.promise;
    });
    await entered.promise;
    const change = host.change();
    change.update(host.installation("a")!, { plugin: provider(2) });
    const plan = await host.plan(change),
      revision = host.stateRevision;
    await expect(host.apply(plan)).rejects.toMatchObject({
      code: "HOST_BUSY",
      details: { outcome: "rejected" },
    });
    await expect(host.stop()).rejects.toMatchObject({ code: "HOST_BUSY" });
    expect(host.stateRevision).toBe(revision);
    exit.resolve();
    await using;
    await host.apply(plan);
    expect(await read(host, value)).toBe(2);
    await host.stop();
  });

  it("does not deadlock a callback that requests its own shutdown", async () => {
    const host = createHost({ installations: [{ id: "a", plugin: provider(1) }] });
    await host.start();
    await host.use(value, async () => {
      await expect(host.stop()).rejects.toMatchObject({ code: "HOST_BUSY" });
    });
    await host.stop();
  });

  it("keeps failed cleanup quarantined and cannot duplicate unfreed resources", async () => {
    let owned = 0;
    const cleanup = vi.fn<() => never>(() => {
      throw new Error("release failed");
    });
    const plugin = definePlugin({
      name: "leaking",
      provides: { value },
      setup({ lifetime }) {
        owned++;
        lifetime.defer(cleanup);
        return { value: owned };
      },
    });
    const host = createHost({ installations: [{ id: "a", plugin }] });
    await host.start();
    await expect(replace(host, "a", provider(2))).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
    });
    expect(host.status).toBe("quarantined");
    expect(host.diagnostics.get().unresolved).toHaveLength(1);
    await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(() => host.change()).toThrowError(expect.objectContaining({ code: "HOST_QUARANTINED" }));
    expect(owned).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("restores old declarations and source on activation failure", async () => {
    const host = createHost({
      installations: [{ id: "a", plugin: provider(1), origin: { version: "1" } }],
    });
    await host.start();
    const handle = host.installation("a")!;
    const broken = definePlugin({
      name: "broken",
      provides: { value },
      setup() {
        throw new Error("new failed");
      },
    });
    await expect(replace(host, "a", broken)).rejects.toMatchObject({
      details: { outcome: "restored" },
    });
    expect(host.installation("a")).toBe(handle);
    expect(handle.origin).toEqual({ version: "1" });
    expect(await read(host, value)).toBe(1);
    expect(host.diagnostics.get().error?.message).toContain("new failed");
    await replace(host, "a", provider(3));
    expect(handle.origin).toBeUndefined();
    expect(await read(host, value)).toBe(3);
    await host.stop();
  });

  it("quarantines when restoration cannot reestablish the old graph", async () => {
    let starts = 0;
    const old = definePlugin({
      name: "old",
      setup() {
        if (++starts > 1) throw new Error("restore failed");
      },
    });
    const host = createHost({ installations: [{ id: "a", plugin: old }] });
    await host.start();
    await expect(
      replace(
        host,
        "a",
        definePlugin({
          name: "new",
          setup() {
            throw new Error("new failed");
          },
        }),
      ),
    ).rejects.toMatchObject({ details: { outcome: "quarantined", phase: "restore" } });
    expect(host.status).toBe("quarantined");
  });

  it("quarantines startup cleanup failures", async () => {
    const host = createHost({
      installations: [
        {
          id: "a",
          plugin: definePlugin({
            name: "a",
            setup({ lifetime }) {
              lifetime.defer(() => {
                throw new Error("cleanup");
              });
              throw new Error("setup");
            },
          }),
        },
      ],
    });
    await expect(host.start()).rejects.toMatchObject({ details: { outcome: "quarantined" } });
    expect(host.diagnostics.get().unresolved[0]?.lifetime.unresolved.length).toBeGreaterThan(0);
  });

  it("keeps contributions dynamic without rebuilding their consumer", async () => {
    const items = extensionPoint<number>("host/items"),
      starts = vi.fn<() => void>();
    const consumer = definePlugin({
      name: "consumer",
      requires: { items },
      setup() {
        starts();
      },
    });
    const host = createHost({ installations: [{ id: "consumer", plugin: consumer }] });
    const view = host.contributions(items);
    await host.start();
    const change = host.change();
    const installed = change.install(
      definePlugin({
        name: "item",
        setup({ contributions }) {
          contributions.add(items, "one", 1);
        },
      }),
      { id: "item" },
    );
    await host.apply(await host.plan(change));
    expect(await Promise.all(view.get().map((id) => view.use(id, (value) => value)))).toEqual([1]);
    expect(starts).toHaveBeenCalledOnce();
    const remove = host.change();
    remove.remove(installed);
    await host.apply(await host.plan(remove));
    expect(view.get().length).toBe(0);
    await host.stop();
  });

  it("keeps observer failures outside the committed outcome", async () => {
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({ onError: report, installations: [{ id: "a", plugin: provider(1) }] });
    const subscription = host.diagnostics.subscribe(() => {
      throw new Error("observer");
    });
    await expect(host.start()).resolves.toEqual({ stateRevision: 1, affectedInstallations: ["a"] });
    expect(await read(host, value)).toBe(1);
    expect(report).toHaveBeenCalled();
    subscription[Symbol.dispose]();
    await host.stop();
  });

  it("observes failing async error reporters through the terminal logger", async () => {
    const logger: Logger = { debug() {}, info() {}, warn() {}, error: vi.fn<Logger["error"]>() };
    const host = createHost({
      logger,
      onError: async () => {
        throw new Error("report");
      },
    });
    host.diagnostics.subscribe(() => {
      throw new Error("observer");
    });
    await host.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    await host.stop();
  });

  it("adds immutable instance identity to log records and revokes a retained logger", async () => {
    const logger: Logger = {
      debug: vi.fn<Logger["debug"]>(),
      info: vi.fn<Logger["info"]>(),
      warn: vi.fn<Logger["warn"]>(),
      error: vi.fn<Logger["error"]>(),
    };
    let context!: PluginContext<{}>;
    const host = createHost({
      name: "demo",
      logger,
      installations: [
        {
          id: "a",
          plugin: definePlugin({
            name: "a",
            setup(ctx) {
              context = ctx;
              for (const level of ["debug", "info", "warn", "error"] as const)
                ctx.log[level]("ready");
              ctx.lifetime.defer(() => ctx.log.info("closing"));
            },
          }),
        },
      ],
    });
    await host.start();
    expect(logger.info).toHaveBeenCalledWith("ready", {
      hostName: "demo",
      installationId: "a",
      pluginName: "a",
      generation: 1,
      groupId: undefined,
    });
    expect(Object.isFrozen(context.meta)).toBe(true);
    await host.stop();
    expect(() => context.log.info("late")).toThrowError(
      expect.objectContaining({ code: "LIFETIME_DISPOSED" }),
    );
  });

  it.each([
    { name: " " },
    { name: " padded " },
    { logger: {} },
    { onError: 1 },
    { shutdownTimeoutMs: 0 },
    { groups: {} },
    { installations: {} },
  ])("validates Host input %j", (options) => {
    expect(() => createHost(options as never)).toThrow(TypeError);
  });

  it.each([undefined, {}, null, { extra: 1 }, { value: 1, extra: 1 }])(
    "rejects malformed setup output %j",
    async (result) => {
      const host = createHost({
        installations: [
          {
            id: "a",
            plugin: definePlugin({ name: "a", provides: { value }, setup: () => result as never }),
          },
        ],
      });
      await expect(host.start()).rejects.toMatchObject({ details: { outcome: "restored" } });
    },
  );

  it("rejects a value from a declaration without provisions", async () => {
    const host = createHost({
      installations: [{ id: "a", plugin: definePlugin({ name: "a", setup: () => ({}) as never }) }],
    });
    await expect(host.start()).rejects.toMatchObject({ details: { outcome: "restored" } });
  });
});

it("reports the concrete Service cycle even in a dependency graph deeper than the call stack", () => {
  const count = 8_000;
  const tokens = Array.from({ length: count }, (_, i) => service<void>(`chain/${i}`));
  const installations = tokens.map((token, i) => ({
    id: String(i),
    plugin: definePlugin({
      name: String(i),
      provides: { token },
      requires: { previous: tokens[(i + count - 1) % count]! },
      setup: () => ({ token: undefined }),
    }),
  }));
  let reason: unknown;
  try {
    createHost({ installations });
  } catch (error) {
    reason = error;
  }
  expect(reason).toMatchObject({ code: "SERVICE_CYCLE" });
  const path = (reason as { details: { dependencyPath: readonly string[] } }).details
    .dependencyPath;
  expect(path).toHaveLength(count + 1);
  expect(path[0]).toBe(path[count]);
  expect(Number(path[1])).toBe((Number(path[0]) + 1) % count);
});
