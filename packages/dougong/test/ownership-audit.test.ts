import { expect, it, vi } from "vitest";
import { createHost, definePlugin, event, extensionPoint, service } from "../src";

it("publishes committed Host availability only with the matching contribution snapshot", async () => {
  const value = service<number>("audit/committed-value");
  const values = extensionPoint<number>("audit/committed-values");
  const plugin = (current: number) =>
    definePlugin({
      name: "audit.commit-publication",
      provides: { value },
      setup(ctx) {
        ctx.contributions.add(values, "value", current);
        return { value: current };
      },
    });
  const host = createHost({ installations: [{ id: "provider", plugin: plugin(1) }] });
  const installation = host.installation("provider")!;
  const contributions = host.contributions(values);
  await host.start();
  const observations: Array<readonly [number, number | undefined]> = [];
  const readings: Promise<void>[] = [];
  let revision = host.stateRevision;
  using subscription = host.diagnostics.subscribe(() => {
    const snapshot = host.diagnostics.get();
    if (snapshot.status !== "running" || snapshot.stateRevision === revision) return;
    revision = snapshot.stateRevision;
    readings.push(
      host.use(value, (current) => {
        observations.push([current, contributions.get().get(`${installation.id}/value`)]);
      }),
    );
  });
  const change = host.change();
  change.update(installation, { plugin: plugin(2) });
  await host.apply(await host.plan(change));
  await Promise.all(readings);
  expect(observations).toEqual([[2, 2]]);
  subscription[Symbol.dispose]();
  await host.stop();
});

it.each(["startup", "change"] as const)(
  "publishes failed cleanup ownership with a quarantined Host after %s",
  async (operation) => {
    const cleanup = vi.fn<() => void>(() => {
      throw new Error("audit cleanup failure");
    });
    const original = definePlugin({ name: "audit.owner", setup() {} });
    const broken = definePlugin({
      name: "audit.owner",
      setup(ctx) {
        ctx.lifetime.defer(cleanup);
        throw new Error("audit setup failure");
      },
    });
    const host = createHost({
      installations: [{ id: "owner", plugin: operation === "startup" ? broken : original }],
    });
    if (operation === "change") await host.start();
    const snapshots: ReturnType<typeof host.inspect>[] = [];
    using _subscription = host.diagnostics.subscribe(() => {
      const snapshot = host.inspect();
      if (snapshot.status === "quarantined") snapshots.push(snapshot);
    });
    let command: Promise<unknown>;
    if (operation === "startup") command = host.start();
    else {
      const change = host.change();
      change.update(host.installation("owner")!, { plugin: broken });
      command = host.apply(await host.plan(change));
    }
    await expect(command).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.installations.every((record) => record.status !== "running")).toBe(true);
      expect(snapshot.unresolved.some((record) => record.lifetime.unresolved.length > 0)).toBe(
        true,
      );
    }
    await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(cleanup).toHaveBeenCalledOnce();
  },
);

it("projects sealed descendants before resource withdrawal can notify observers", async () => {
  const notice = event<void>("audit/sealed-lifetime");
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "audit.sealed-lifetime",
          setup(ctx) {
            ctx.events.on(notice, () => undefined);
            ctx.events.on(notice, () => undefined, { lifetime: ctx.lifetime.child("child") });
          },
        }),
      },
    ],
  });
  await host.start();
  const phases: string[] = [];
  using _subscription = host.diagnostics.subscribe(() => {
    const snapshot = host.inspect();
    if (snapshot.status !== "stopping") return;
    for (const installation of snapshot.installations) {
      const lifetime = installation.lifetime;
      if (lifetime) phases.push(lifetime.phase, ...lifetime.children.map((child) => child.phase));
    }
  });
  await host.stop();
  expect(phases.length).toBeGreaterThan(0);
  expect(phases).not.toContain("active");
  expect(host.inspect().installations[0]?.lifetime).toBeUndefined();
});

it("projects Installation status from the same committed owner as Host diagnostics", async () => {
  const host = createHost({
    installations: [
      { id: "owner", plugin: definePlugin({ name: "audit.projection", setup() {} }) },
    ],
  });
  const installation = host.installation("owner")!;
  const observed: Array<readonly [string, string | undefined]> = [];
  using _eager = host.diagnostics.subscribe(() => {
    host.inspect();
  });
  using _subscription = host.diagnostics.subscribe(() => {
    observed.push([
      installation.status,
      host.inspect().installations.find((record) => record.id === installation.id)?.status,
    ]);
  });
  await host.start();
  await host.stop();
  expect(observed.length).toBeGreaterThan(0);
  for (const [own, aggregate] of observed) expect(aggregate).toBe(own);
});

it("keeps dependency and group membership committed while a Plan validates", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const capability = service<number>("audit/readiness");
  const provider = definePlugin({
    name: "audit.provider",
    provides: { value: capability },
    setup: () => ({ value: 1 }),
  });
  const consumer = definePlugin({
    name: "audit.consumer",
    requires: { value: capability },
    setup() {},
  });
  const host = createHost({
    groups: [{ id: "consumers" }, { id: "empty", parentId: "consumers" }],
    installations: [
      { id: "provider", plugin: provider },
      { id: "consumer", plugin: consumer, groupId: "consumers" },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const before = host.inspect();
  const change = host.change();
  change.update(host.installation("provider")!, {
    plugin: definePlugin({
      ...provider,
      config: {
        "~standard": {
          version: 1,
          vendor: "audit",
          async validate(): Promise<{ value: void }> {
            entered.resolve();
            await resume.promise;
            return { value: undefined };
          },
        },
      },
    }),
  });
  const planning = host.plan(change);
  await entered.promise;
  expect(host.status).toBe("running");
  expect(host.stateRevision).toBe(revision);
  expect(host.inspect()).toBe(before);
  expect(await host.use(capability, (value) => value)).toBe(1);
  expect(host.group("empty")?.parentId).toBe("consumers");
  resume.resolve();
  const plan = await planning;
  expect(host.stateRevision).toBe(revision);
  expect(plan.report.affectedInstallations).toEqual(["provider", "consumer"]);
  await host.apply(plan);
  expect(host.stateRevision).toBe(revision + 1);
  await host.stop();
});

it("reports committed removal observer failures without changing the transition outcome", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    onError: report,
    installations: [{ id: "owner", plugin: definePlugin({ name: "audit.terminal", setup() {} }) }],
  });
  const installation = host.installation("owner")!;
  await host.start();
  const failure = new Error("terminal subscriber");
  let observed = false;
  using _subscription = host.diagnostics.subscribe(() => {
    if (!observed && installation.status === "removed") {
      observed = true;
      throw failure;
    }
  });
  const change = host.change();
  change.remove(installation);
  await expect(host.apply(await host.plan(change))).resolves.toMatchObject({
    outcome: "committed",
  });
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  await host.stop();
});

it("rejects executable Contract identities before validation can read a different fact", () => {
  let reads = 0;
  const capability = Object.defineProperty({ ...service<number>("audit/inert") }, "id", {
    enumerable: true,
    get() {
      reads++;
      return reads <= 4 ? "audit/inert" : " invalid identity ";
    },
  });
  expect(() =>
    definePlugin({
      name: "audit.executable-contract",
      provides: { value: capability },
      setup: () => ({ value: 1 }),
    }),
  ).toThrow(TypeError);
  expect(reads).toBe(0);
});

it("rejects the stale concurrent removal Plan without releasing one Installation twice", async () => {
  const cleanup = vi.fn<() => void>();
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "audit.concurrent-removal",
          setup(ctx) {
            ctx.lifetime.defer(cleanup);
          },
        }),
      },
    ],
  });
  await host.start();
  const installation = host.installation("owner")!;
  const first = host.change();
  const second = host.change();
  first.remove(installation);
  second.remove(installation);
  const plans = await Promise.all([host.plan(first), host.plan(second)]);
  const results = await Promise.allSettled(plans.map((plan) => host.apply(plan)));
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "PLAN_STALE" } });
  expect(cleanup).toHaveBeenCalledOnce();
  await host.stop();
});
