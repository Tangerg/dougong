import { expect, it, vi } from "vitest";
import { createHost, definePlugin, service, type Group, type Installation } from "../src";

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
