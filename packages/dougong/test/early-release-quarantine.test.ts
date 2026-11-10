import { expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  service,
  type AsyncDisposable,
  type LifetimeContext,
} from "../src";

const resourceAuthority = createResourceAuthority();

it.each(["child", "cleanup"] as const)(
  "quarantines early %s release failure and retains its providers",
  async (kind) => {
    const provider = service<number>("early-release/provider");
    const value = service<number>("early-release/value");
    const failure = new Error("owned resource was not released");
    const releaseFailed = vi.fn<() => never>(() => {
      throw failure;
    });
    const releaseProvider = vi.fn<() => void>();
    const releaseIndependent = vi.fn<() => void>();
    const reported = Promise.withResolvers<unknown>();
    const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
    let early!: AsyncDisposable;
    const host = createHost({
      resourceAuthority,
      onError: report,
      installations: [
        {
          id: "provider",
          plugin: definePlugin({
            name: "provider",
            provides: { provider },
            setup({ lifetime }) {
              lifetime.defer(releaseProvider);
              return { provider: 7 };
            },
          }),
        },
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            requires: { provider },
            provides: { value },
            setup({ lifetime, dependencies }) {
              if (kind === "child") {
                const child = lifetime.child("failed-resource");
                child.defer(releaseFailed);
                early = child;
              } else early = lifetime.defer(releaseFailed);
              return { value: dependencies.provider };
            },
          }),
        },
        {
          id: "independent",
          plugin: definePlugin({
            name: "independent",
            setup({ lifetime }) {
              lifetime.defer(releaseIndependent);
            },
          }),
        },
      ],
    });
    await host.start();
    const revision = host.stateRevision;
    const plan = await host.plan(host.change());
    await expect(early[Symbol.asyncDispose]()).rejects.toBeDefined();
    expect(host.status).toBe("quarantined");
    await expect(host.use(value, (current) => current)).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
    });
    await expect(host.apply(plan)).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    await expect(reported.promise).resolves.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(host.stateRevision).toBe(revision + 1);
    expect(releaseIndependent).toHaveBeenCalledOnce();
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(releaseFailed).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
      "provider",
      "owner",
    ]);
    await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(releaseFailed).toHaveBeenCalledOnce();
  },
);

it("does not commit a candidate after its early child release fails during preparation", async () => {
  const failure = new Error("candidate child release failed");
  const releaseProvider = vi.fn<() => void>();
  const provider = service<number>("preparing-release/provider");
  const setupLater = vi.fn<() => void>();
  const value = service<number>("preparing-release/value");
  const host = createHost({
    resourceAuthority,
    onError() {},
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { provider },
          setup({ lifetime }) {
            lifetime.defer(releaseProvider);
            return { provider: 7 };
          },
        }),
      },
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          requires: { provider },
          provides: { value },
          async setup({ lifetime, dependencies }) {
            const child = lifetime.child("failed-child");
            child.defer(() => {
              throw failure;
            });
            await child[Symbol.asyncDispose]().catch(() => undefined);
            return { value: dependencies.provider };
          },
        }),
      },
      {
        id: "later",
        plugin: definePlugin({
          name: "later",
          requires: { value },
          setup: setupLater,
        }),
      },
    ],
  });
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(host.status).toBe("quarantined");
  expect(setupLater).not.toHaveBeenCalled();
  expect(releaseProvider).not.toHaveBeenCalled();
  expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
    "provider",
    "owner",
  ]);
});

it("blocks an active transition when an unaffected Instance loses a cleanup obligation", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const releaseCandidate = vi.fn<() => void>();
  const value = service<number>("concurrent-release/value");
  let lifetime!: LifetimeContext;
  let early!: AsyncDisposable;
  const host = createHost({
    resourceAuthority,
    onError() {},
    installations: [
      {
        id: "failing",
        plugin: definePlugin({
          name: "failing",
          setup(context) {
            early = context.lifetime.defer(() => {
              throw new Error("early cleanup failed");
            });
          },
        }),
      },
      {
        id: "changing",
        plugin: definePlugin({
          name: "changing",
          provides: { value },
          setup: () => ({ value: 1 }),
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("changing")!, {
    plugin: definePlugin({
      name: "changing",
      provides: { value },
      async setup(context) {
        lifetime = context.lifetime;
        lifetime.defer(releaseCandidate);
        entered.resolve();
        await resume.promise;
        return { value: 2 };
      },
    }),
  });
  const applying = host.apply(await host.plan(change)).catch((error: unknown) => error);
  await entered.promise;
  await expect(early[Symbol.asyncDispose]()).rejects.toBeDefined();
  const revision = host.stateRevision;
  expect(host.status).toBe("quarantined");
  expect(lifetime.signal.aborted).toBe(true);
  resume.resolve();
  expect(await applying).toMatchObject({ code: "HOST_QUARANTINED" });
  expect(releaseCandidate).toHaveBeenCalledOnce();
  expect(host.stateRevision).toBe(revision);
  expect(host.status).toBe("quarantined");
  await expect(host.use(value, (current) => current)).rejects.toMatchObject({
    code: "HOST_QUARANTINED",
  });
});

it("seals Host ingress before inspecting a failed cleanup's error", async () => {
  const value = service<number>("quarantine-reflection/value");
  const statuses: string[] = [];
  const borrowed: number[] = [];
  let early!: AsyncDisposable;
  let borrowing: Promise<unknown> | undefined;
  const cause = new Error("failed cleanup");
  Object.defineProperty(cause, "message", {
    get() {
      statuses.push(host.status);
      borrowing ??= host
        .use(value, (current) => borrowed.push(current))
        .catch((error: unknown) => error);
      return "failed cleanup";
    },
  });
  const host = createHost({
    resourceAuthority,
    onError() {},
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          provides: { value },
          setup({ lifetime }) {
            early = lifetime.defer(() => {
              throw cause;
            });
            return { value: 7 };
          },
        }),
      },
    ],
  });
  await host.start();
  await expect(early[Symbol.asyncDispose]()).rejects.toBe(cause);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses).toEqual(statuses.map(() => "quarantined"));
  await expect(borrowing).resolves.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(borrowed).toEqual([]);
});
