import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
  type Group,
  type Installation,
} from "../src";

it("publishes committed Host availability only with the matching contribution snapshot", async () => {
  const host = createHost();
  const value = service<number>("audit/committed-value");
  const values = extensionPoint<number>("audit/committed-values");
  const plugin = (current: number) =>
    definePlugin({
      name: "audit.commit-publication",
      provides: { value },
      setup(ctx) {
        ctx.contribute(values, "value", current);
        return { value: current };
      },
    });
  const installation = host.install(plugin(1));
  const contributions = host.contributions(values);
  await host.start();
  const observations: Array<readonly [number, number | undefined]> = [];
  const subscription = host.diagnostics.subscribe(() => {
    if (host.status !== "active") return;
    observations.push([host.get(value), contributions.get().get(`${installation.id}/value`)]);
  });

  await installation.update({ plugin: plugin(2) });
  subscription.dispose();
  await host.stop();

  expect(observations.length).toBeGreaterThan(0);
  for (const [serviceValue, contributionValue] of observations) {
    expect(contributionValue).toBe(serviceValue);
  }
});

it.each(["startup", "change"] as const)(
  "finishes failed Installation states before publishing an idle Host after %s",
  async (operation) => {
    const host = createHost();
    const failure = new Error("audit failure");
    const plugin = definePlugin({
      name: "audit.failure-publication",
      setup(ctx) {
        ctx.cleanup(() => {
          throw failure;
        });
      },
    });
    const installation = host.install(plugin);
    host.install(definePlugin({ name: "audit.unrelated-failure-publication", setup() {} }));
    if (operation === "change") await host.start();
    else {
      host.install(
        definePlugin({
          name: "audit.missing-dependency",
          requires: { missing: service<void>("audit/missing-dependency") },
          setup() {},
        }),
      );
      await host.change().commit();
    }
    const snapshots: string[][] = [];
    const subscription = host.diagnostics.subscribe(() => {
      const snapshot = host.diagnostics.get();
      if (snapshot.status === "idle") {
        snapshots.push([...snapshot.installations.values()].map((record) => record.status));
      }
    });

    const command = operation === "startup" ? host.start() : installation.update({ plugin });
    await expect(command).rejects.toBeInstanceOf(Error);
    subscription.dispose();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const statuses of snapshots)
      expect(statuses.every((status) => status === "failed")).toBe(true);
    await host.stop();
  },
);

it("projects the sealed Lifetime phase before resource withdrawal notifies observers", async () => {
  const host = createHost();
  const notice = event<void>("audit/sealed-lifetime");
  const installation = host.install(
    definePlugin({
      name: "audit.sealed-lifetime",
      setup(ctx) {
        ctx.on(notice, () => undefined);
        ctx.lifetime("child").on(notice, () => undefined);
      },
    }),
  );
  await host.start();
  const lifetime = installation.diagnostics.get().lifetime!;
  const phases: string[] = [];
  lifetime.subscribe(() => {
    const snapshot = lifetime.get();
    phases.push(snapshot.phase, ...snapshot.children.map((child) => child.phase));
  });
  await host.stop();
  expect(phases.length).toBeGreaterThan(0);
  expect(phases).not.toContain("active");
  expect(lifetime.get().phase).toBe("disposed");
});

it("invalidates Installation and Host projections before either observer runs", async () => {
  const host = createHost();
  const installation = host.install(definePlugin({ name: "audit.projection", setup() {} }));
  const eager = host.diagnostics.subscribe(() => {
    host.diagnostics.get();
  });
  const observed: Array<readonly [string, string | undefined]> = [];
  const subscription = installation.diagnostics.subscribe(() => {
    observed.push([
      installation.diagnostics.get().status,
      host.diagnostics.get().installations.get(installation.id)?.status,
    ]);
  });
  await host.start();
  await host.stop();
  expect(observed.length).toBeGreaterThan(0);
  for (const [own, aggregate] of observed) expect(aggregate).toBe(own);
  subscription.dispose();
  eager.dispose();
});

it("keeps dependent Installation and Group readiness behind the Host transaction", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const capability = service<number>("audit/readiness");
  const provider = definePlugin({
    name: "audit.provider",
    provides: { value: capability },
    setup: () => ({ value: 1 }),
  });
  const host = createHost();
  const installation = host.install(provider);
  const consumerPlugin = definePlugin({
    name: "audit.consumer",
    requires: { value: capability },
    setup() {},
  });
  let consumer!: Installation<typeof consumerPlugin>;
  let empty!: Group;
  const group = host.group("consumer", (target) => {
    consumer = target.install(consumerPlugin);
    empty = target.group("empty", () => undefined);
  });
  await host.start();
  const change = installation.update({
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
  await entered.promise;
  const finished: string[] = [];
  const ready = Promise.all(
    [consumer, group, empty].map(async (target, index) => {
      await target.ready();
      finished.push(String(index));
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const premature = [...finished];
  resume.resolve();
  await change;
  await ready;
  expect(finished).toHaveLength(3);
  await host.stop();
  expect(premature).toEqual([]);
});

it("reports final Installation observer failures before releasing Host authority", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({ onError: report });
  const installation = host.install(definePlugin({ name: "audit.terminal", setup() {} }));
  await host.start();
  const failure = new Error("terminal subscriber");
  installation.diagnostics.subscribe(() => {
    if (installation.status === "removed") throw failure;
  });
  await installation.remove();
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

it("joins concurrent removal requests for one Installation", async () => {
  const host = createHost();
  const cleanup = vi.fn<() => void>();
  const installation = host.install(
    definePlugin({
      name: "audit.concurrent-removal",
      setup(ctx) {
        ctx.cleanup(cleanup);
      },
    }),
  );
  await host.start();
  const results = await Promise.allSettled([installation.remove(), installation.remove()]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(cleanup).toHaveBeenCalledTimes(1);
  await host.stop();
});
