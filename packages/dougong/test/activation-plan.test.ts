import { expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createHost, definePlugin, optional, service, type Plan } from "../src/index";

const value = service<number>("plan/value");
const provider = (number: number) =>
  definePlugin({ name: "provider", provides: { value }, setup: () => ({ value: number }) });

it("explains declaration origins, both binding states and publication order without configuration values", async () => {
  const consumer = definePlugin({
    name: "consumer",
    requires: { value: optional(value) },
    setup() {},
  });
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: provider(1),
        configuration: { secret: "not-public" },
        origin: { revision: "one" },
      },
      { id: "consumer", plugin: consumer },
    ],
  });
  await host.start();
  const update = host.change();
  update.update(host.installation("provider")!, {
    plugin: provider(2),
    origin: { revision: "two" },
  });
  const plan = await host.plan(update);
  expect(plan.report.operations).toEqual([
    {
      kind: "update",
      id: "provider",
      before: { pluginName: "provider", origin: { revision: "one" } },
      after: { pluginName: "provider", origin: { revision: "two" } },
    },
  ]);
  expect(plan.report.bindings.before).toEqual(plan.report.bindings.after);
  expect(plan.report.stopOrder).toEqual(["consumer", "provider"]);
  expect(plan.report.prepareOrder).toEqual(["provider", "consumer"]);
  expect(plan.report.publishOrder).toEqual(["provider", "consumer"]);
  expect(JSON.stringify(plan.report)).not.toContain("not-public");
  await host.apply(plan);

  const remove = host.change();
  remove.remove(host.installation("provider")!);
  const removal = await host.plan(remove);
  expect(removal.report.bindings.before).toEqual([
    { installation: "consumer", contract: value.id, optional: true, provider: "provider" },
  ]);
  expect(removal.report.bindings.after).toEqual([
    { installation: "consumer", contract: value.id, optional: true, provider: undefined },
  ]);
  expect(removal.report.reasons).toContainEqual({
    installation: "consumer",
    kind: "provider_changed",
    contract: value.id,
    previousProvider: "provider",
  });
  expect(removal.report.operations[0]).toMatchObject({
    before: { origin: { revision: "two" } },
    after: undefined,
  });
  await host.apply(removal);
  await host.stop();
});

it("reports declaration-only changes without claiming runtime stop or publish work", async () => {
  const host = createHost();
  const change = host.change();
  const group = change.group("root");
  change.install(provider(1), { id: "provider", group });
  const plan = await host.plan(change);
  expect(plan.report.operations).toEqual([
    { kind: "group", id: "root", parentId: undefined },
    {
      kind: "install",
      id: "provider",
      before: undefined,
      after: { pluginName: "provider", origin: undefined },
    },
  ]);
  expect(plan.report.stopOrder).toEqual([]);
  expect(plan.report.prepareOrder).toEqual([]);
  expect(plan.report.publishOrder).toEqual([]);
  expect(Object.isFrozen(plan.report.bindings)).toBe(true);
  await host.apply(plan);
});

it("captures normalized configuration once and consumes only the issuing Host plan", async () => {
  const validate = vi.fn<(input: unknown) => { value: { n: number } }>((input) => ({
    value: { n: Number(input) },
  }));
  const schema: StandardSchemaV1<string, { n: number }> = {
    "~standard": { version: 1 as const, vendor: "test", validate },
  };
  const plugin = definePlugin({
    name: "configured",
    configuration: schema,
    provides: { value },
    setup(_context, configuration) {
      return { value: configuration.n };
    },
  });
  const host = createHost(),
    other = createHost();
  const change = host.change();
  change.install(plugin, { id: "configured", configuration: "3" });
  const plan = await host.plan(change);
  expect(validate).toHaveBeenCalledOnce();
  expect(host.installation("configured")).toBeUndefined();
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.report)).toBe(true);
  await expect(other.apply(plan)).rejects.toMatchObject({ code: "PLAN_FOREIGN" });
  await expect(host.apply({ report: plan.report } as Plan)).rejects.toMatchObject({
    code: "PLAN_FOREIGN",
  });
  await host.apply(plan);
  await host.start();
  expect(validate).toHaveBeenCalledOnce();
  expect(await host.use(value, (result) => result)).toBe(3);
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_CONSUMED" });
  await host.stop();
});

it("rejects stale plans before touching resources", async () => {
  const dispose = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(dispose);
            return { value: 1 };
          },
        }),
      },
    ],
  });
  await host.start();
  const first = host.change(),
    second = host.change();
  first.update(host.installation("a")!, { plugin: provider(2) });
  second.update(host.installation("a")!, { plugin: provider(3) });
  const [firstPlan, secondPlan] = await Promise.all([host.plan(first), host.plan(second)]);
  await host.apply(firstPlan);
  await expect(host.apply(secondPlan)).rejects.toMatchObject({
    code: "PLAN_STALE",
    details: {
      expectedRevision: firstPlan.report.baseStateRevision,
      stateRevision: host.stateRevision,
    },
  });
  expect(dispose).toHaveBeenCalledOnce();
  expect(await host.use(value, (result) => result)).toBe(2);
  await host.stop();
});

it("does not execute setup while planning and retains empty change identity", async () => {
  const setup = vi.fn<() => void>();
  const host = createHost();
  const change = host.change();
  change.install(definePlugin({ name: "a", setup }), { id: "a" });
  const plan = await host.plan(change);
  expect(setup).not.toHaveBeenCalled();
  await host.apply(plan);
  expect(setup).not.toHaveBeenCalled();
  const revision = host.stateRevision;
  const empty = await host.plan(host.change());
  await host.apply(empty);
  expect(host.stateRevision).toBe(revision);
  await host.start();
  expect(setup).toHaveBeenCalledOnce();
  await host.stop();
});

it("restores using captured configuration without rerunning its validator", async () => {
  const validate = vi.fn<() => { value: undefined }>(() => ({ value: undefined }));
  const started: string[] = [];
  const old = definePlugin({
    name: "old",
    configuration: { "~standard": { version: 1 as const, vendor: "test", validate } },
    setup() {
      started.push("old");
    },
  });
  const host = createHost({ installations: [{ id: "a", plugin: old }] });
  await host.start();
  const change = host.change();
  change.update(host.installation("a")!, {
    plugin: definePlugin({
      name: "new",
      setup() {
        throw new Error("failure");
      },
    }),
  });
  await expect(host.apply(await host.plan(change))).rejects.toMatchObject({
    details: { outcome: "restored" },
  });
  expect(started).toEqual(["old", "old"]);
  expect(validate).toHaveBeenCalledOnce();
  await host.stop();
});

it("makes a ChangeSet one-shot and rejects foreign authorities", async () => {
  const host = createHost(),
    other = createHost();
  const change = host.change(),
    foreign = other.change();
  const installation = change.install(provider(1), { id: "a" });
  expect(() => change.remove(installation)).toThrow("only once");
  await expect(other.plan(change)).rejects.toMatchObject({ code: "CHANGE_FOREIGN" });
  await host.plan(change);
  expect(() => change.install(provider(2), { id: "b" })).toThrow("already been planned");
  await expect(host.plan(change)).rejects.toMatchObject({ code: "CHANGE_FOREIGN" });
  expect(() => foreign.remove(installation)).toThrowError(
    expect.objectContaining({ code: "INSTALLATION_FOREIGN" }),
  );
});

it("reports validation failure without changing the running generation", async () => {
  const stop = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(stop);
            return { value: 1 };
          },
        }),
      },
    ],
  });
  await host.start();
  const before = host.diagnostics.get();
  const change = host.change();
  change.install(provider(2), { id: "conflict" });
  await expect(host.plan(change)).rejects.toMatchObject({ code: "SERVICE_CONFLICT" });
  expect(host.diagnostics.get()).toBe(before);
  expect(stop).not.toHaveBeenCalled();
  await host.stop();
});

it("orders independent Installations by committed declarations even when drafts are staged out of order", async () => {
  const host = createHost();
  const starts: string[] = [];
  const plugin = definePlugin({
    name: "ordered",
    setup({ metadata }) {
      starts.push(metadata.installationId);
    },
  });
  const earlierDraft = host.change();
  earlierDraft.install(plugin, { id: "committed-second" });
  const laterDraft = host.change();
  laterDraft.install(plugin, { id: "committed-first" });
  await host.apply(await host.plan(laterDraft));
  await host.apply(await host.plan(earlierDraft));

  const committed = host.diagnostics.get().installations.map(({ id }) => id);
  expect(committed).toEqual(["committed-first", "committed-second"]);
  await host.start();
  expect(starts).toEqual(committed);

  const change = host.change();
  for (const id of [...committed].reverse()) change.update(host.installation(id)!, { plugin });
  const plan = await host.plan(change);
  expect(plan.report.prepareOrder).toEqual(committed);
  await host.apply(plan);
  expect(starts).toEqual([...committed, ...committed]);
  await host.stop();
});
