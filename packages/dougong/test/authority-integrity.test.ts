import { expect, it, vi } from "vitest";
import {
  captureConfig,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type Logger,
  service,
} from "../src/index";

it("exposes staging commands without granting access to committed Installation records", async () => {
  const host = createHost({
    installations: [{ id: "original", plugin: definePlugin({ name: "original", setup() {} }) }],
  });
  const original = host.installation("original")!;
  const change = host.change();
  change.update(original, { config: undefined });
  expect("take" in change).toBe(false);
  expect(Object.isFrozen(change)).toBe(true);
  expect(original.status).toBe("stopped");
  const plan = await host.plan(change);
  expect("blockers" in plan.report).toBe(false);
  expect(await host.apply(plan)).toMatchObject({ affectedInstallations: ["original"] });
});

it("rejects creation in a subtree removed by the same change in either command order", async () => {
  const host = createHost({ groups: [{ id: "parent" }, { id: "existing", parentId: "parent" }] });
  const parent = host.group("parent")!;
  const existing = host.group("existing")!;
  for (const removalFirst of [true, false]) {
    const change = host.change();
    if (removalFirst) change.removeGroup(parent);
    change.group("grandchild", existing);
    if (!removalFirst) change.removeGroup(parent);
    await expect(host.plan(change)).rejects.toMatchObject({ code: "CHANGE_CONFLICT" });
    expect(host.group("parent")).toBe(parent);
    expect(host.stateRevision).toBe(0);
  }
});

it("consumes an authorized Plan permanently invalidated by a new Contract kind before effects", async () => {
  const host = createHost();
  await host.start();
  const value = service<number>("authority/new-kind");
  const setup = vi.fn<() => { value: number }>(() => ({ value: 1 }));
  const change = host.change();
  const pending = change.install(definePlugin({ name: "provider", provides: { value }, setup }), {
    id: "provider",
  });
  const plan = await host.plan(change);
  host.contributions(extensionPoint(value.id));
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_CONSUMED" });
  expect(pending.status).toBe("removed");
  expect(host.stateRevision).toBe(plan.report.baseStateRevision);
  expect(setup).not.toHaveBeenCalled();
  await host.stop();
});

it("validates a candidate's own staged Contract kind even after a competing durable claim", async () => {
  const host = createHost();
  await host.start();
  const staged = event<void>("authority/staged-kind");
  const competing = extensionPoint<number>(staged.id);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const change = host.change();
  change.install(
    definePlugin({
      name: "candidate",
      async setup({ events, contributions }) {
        events.on(staged, () => undefined);
        entered.resolve();
        await resume.promise;
        contributions.add(competing, "value", 1);
      },
    }),
    { id: "candidate" },
  );
  const applying = host.apply(await host.plan(change)).catch((error: unknown) => error);
  await entered.promise;
  const view = host.contributions(competing);
  resume.resolve();
  expect(await applying).toMatchObject({
    code: "TRANSITION_FAILED",
    details: { phase: "prepare", outcome: "restored" },
    cause: { code: "CONTRACT_CONFLICT" },
  });
  expect(host.status).toBe("running");
  expect(view.get().length).toBe(0);
  await host.stop();
});

it("captures an array's own length without invoking a Proxy read that can replace it", () => {
  const value = new Proxy([1, 2], {
    get(target, key, receiver) {
      if (key === "length") throw new Error("config read an executable length");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(captureConfig(value)).toEqual([1, 2]);
});

it("captures a shared input node once across all its paths and still enforces the depth limit", () => {
  let reads = 0;
  const shared = new Proxy(
    { value: 0 },
    {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "value" && descriptor) return { ...descriptor, value: ++reads };
        return descriptor;
      },
    },
  );
  const captured = captureConfig({ left: shared, right: shared });
  expect(captured).toEqual({ left: { value: 1 }, right: { value: 1 } });
  expect(reads).toBe(1);
  let nested: object = shared;
  for (let depth = 0; depth < 63; depth++) nested = { next: nested };
  expect(() => captureConfig({ first: shared, nested })).toThrow(/nesting depth/);
});

it("provides callable logging methods without authority to retire the Instance logger", async () => {
  const output = vi.fn<Logger["info"]>();
  let log!: Logger;
  const host = createHost({
    logger: { debug: output, info: output, warn: output, error: output },
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "logger",
          setup(ctx) {
            log = ctx.log;
            const { info } = log;
            info("started", 1);
          },
        }),
      },
    ],
  });
  await host.start();
  expect(output).toHaveBeenCalledWith(
    "started",
    expect.objectContaining({ installationId: "owner" }),
    1,
  );
  expect(Symbol.dispose in log).toBe(false);
  await host.stop();
  expect(() => log.info("late")).toThrowError(
    expect.objectContaining({ code: "LIFETIME_DISPOSED" }),
  );
});

it.each(["name", "groups", "installations"] as const)(
  "rejects an explicitly null %s rather than silently applying an empty/default Host",
  (field) => {
    expect(() => createHost({ [field]: null } as never)).toThrow(TypeError);
  },
);

it("gives application callbacks only their explicit context", async () => {
  const receivers: unknown[] = [];
  const report = function (this: unknown) {
    receivers.push(this);
  };
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup: function (this: unknown) {
            receivers.push(this);
          },
        }),
      },
    ],
  });
  using _subscription = host.diagnostics.subscribe(() => {
    throw new Error("subscriber failed");
  });
  await host.start();
  expect(receivers.length).toBeGreaterThan(1);
  expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
  await host.stop();
});

it("rechecks durable Contract kinds before issuing a Plan after asynchronous validation", async () => {
  const host = createHost();
  const entered = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const shared = service<number>("issue/kind");
  const change = host.change();
  const candidate = change.install(
    definePlugin({
      name: "claim",
      config: {
        "~standard": {
          version: 1,
          vendor: "fixture",
          async validate() {
            entered.resolve();
            await resumed.promise;
            return { value: null };
          },
        },
      },
      provides: { shared },
      setup: () => ({ shared: 1 }),
    }),
    { id: "claim", config: null },
  );
  const planning = host.plan(change);
  await entered.promise;
  host.contributions(extensionPoint(shared.id));
  resumed.resolve();
  await expect(planning).rejects.toMatchObject({ code: "CONTRACT_CONFLICT" });
  expect(candidate.status).toBe("removed");
  expect(host.stateRevision).toBe(0);
});

it.each(["start", "change"] as const)(
  "restores %s when a staged Contract loses admission before publication",
  async (command) => {
    const token = event<void>("commit/kind");
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const released = vi.fn<() => void>();
    const plugin = definePlugin({
      name: "candidate",
      async setup({ events, lifetime }) {
        events.on(token, () => undefined);
        lifetime.defer(released);
        entered.resolve();
        await resumed.promise;
      },
    });
    const host = createHost({
      installations: [{ id: "old", plugin: definePlugin({ name: "old", setup() {} }) }],
    });
    const old = host.installation("old");
    if (command === "change") await host.start();
    const change = host.change();
    change.install(plugin, { id: "candidate" });
    const plan = await host.plan(change);
    if (command === "start") await host.apply(plan);
    const executing = command === "start" ? host.start() : host.apply(plan);
    await entered.promise;
    host.contributions(extensionPoint(token.id));
    resumed.resolve();
    await expect(executing).rejects.toMatchObject({
      code: "TRANSITION_FAILED",
      cause: { code: "CONTRACT_CONFLICT" },
      details: { outcome: "restored", phase: "prepare" },
    });
    expect(host.status).toBe(command === "start" ? "stopped" : "running");
    expect(host.installation("old")).toBe(old);
    expect(released).toHaveBeenCalledTimes(1);
    await host.stop();
  },
);

it("adopts logger methods once, preserving the backend receiver for both plugin and Host errors", async () => {
  const calls: string[] = [];
  let reads = 0;
  const logger = {
    debug() {},
    warn() {},
    get info() {
      reads++;
      return function (this: object) {
        expect(this).toBe(logger);
        calls.push("info");
      };
    },
    error() {
      calls.push("error");
    },
  };
  const host = createHost({
    logger,
    installations: [
      {
        id: "logging",
        plugin: definePlugin({
          name: "logging",
          setup({ log, lifetime }) {
            log.info("message");
            lifetime.spawn(() => {
              throw new Error("task");
            });
          },
        }),
      },
    ],
  });
  Object.defineProperty(logger, "info", {
    value() {
      calls.push("replaced");
    },
  });
  logger.error = () => {
    calls.push("replaced");
  };
  await host.start();
  await host.stop();
  expect(reads).toBe(1);
  expect(calls).toEqual(["info", "error"]);
});
