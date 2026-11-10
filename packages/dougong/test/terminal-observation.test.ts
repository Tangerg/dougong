import { afterEach, expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  extensionPoint,
  type HostSnapshot,
} from "../src";

const resourceAuthority = createResourceAuthority();

afterEach(() => vi.useRealTimers());

it("seals terminal views after delivering the final committed snapshot", async () => {
  const items = extensionPoint<number>("terminal-observation/items");
  let starts = 0;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "original",
        plugin: definePlugin({
          name: "original",
          setup({ contributions }) {
            if (++starts > 1) throw new Error("Restoration failed");
            contributions.add(items, "item", 1);
          },
        }),
      },
    ],
  });
  const diagnostics = host.diagnostics;
  const contributions = host.contributions(items);
  const snapshots: HostSnapshot[] = [];
  const values: ReadonlyArray<string>[] = [];
  using _diagnosticSubscription = diagnostics.subscribe(() => {
    snapshots.push(diagnostics.get());
  });
  using _contributionSubscription = contributions.subscribe(() => {
    values.push(contributions.get());
  });
  await host.start();
  const original = host.installation("original")!;
  const change = host.change();
  change.update(original, {
    plugin: definePlugin({
      name: "replacement",
      setup() {
        throw new Error("Replacement failed");
      },
    }),
  });
  await expect(host.apply(await host.plan(change))).rejects.toMatchObject({
    code: "HOST_QUARANTINED",
  });

  const final = diagnostics.get();
  expect(final).toMatchObject({ status: "quarantined", unresolved: [] });
  expect(snapshots.at(-1)).toBe(final);
  expect(final.error).toBeDefined();
  expect(values.at(-1)).toEqual([]);
  expect(contributions.get()).toEqual([]);
  expect(() => diagnostics.subscribe(() => {})).toThrow("disposed");
  expect(() => contributions.subscribe(() => {})).toThrow("sealed");
  await expect(contributions.use("original/item", () => {})).rejects.toMatchObject({
    code: "LIFETIME_DISPOSED",
  });
  expect(host.installation("original")).toBe(original);
  expect(original.status).toBe("quarantined");
  expect(host.explain("original")).toEqual([]);

  const later = host.contributions(extensionPoint<number>("terminal-observation/later"));
  expect(later.get()).toEqual([]);
  expect(() => later.subscribe(() => {})).toThrow("sealed");
  await expect(later.use("original/item", () => {})).rejects.toMatchObject({
    code: "LIFETIME_DISPOSED",
  });
});

it("keeps stopped Host views active across restart", async () => {
  const items = extensionPoint<number>("terminal-observation/restart");
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ contributions }) {
            contributions.add(items, "item", 1);
          },
        }),
      },
    ],
  });
  const diagnostics = host.diagnostics;
  const contributions = host.contributions(items);
  await host.start();
  await host.stop();
  using _diagnosticSubscription = diagnostics.subscribe(() => {});
  using _contributionSubscription = contributions.subscribe(() => {});
  await host.start();
  expect(diagnostics.get().status).toBe("running");
  expect(contributions.get()).toEqual(["owner/item"]);
  await expect(contributions.use("owner/item", (value) => value)).resolves.toEqual({ value: 1 });
  await host.stop();
});

it("delivers late shutdown progress before sealing observation without a new revision", async () => {
  vi.useFakeTimers();
  const shutdownTimeoutMilliseconds = 10;
  const release = Promise.withResolvers<void>();
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    resourceAuthority,
    shutdownTimeoutMilliseconds,
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            lifetime.defer(() => release.promise);
          },
        }),
      },
    ],
  });
  const diagnostics = host.diagnostics;
  await host.start();
  const stopping = host.stop().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
    expect(await stopping).toMatchObject({ code: "HOST_QUARANTINED" });
    const revision = host.stateRevision;
    expect(diagnostics.get().unresolved).toHaveLength(1);
    const snapshots: HostSnapshot[] = [];
    using _subscription = diagnostics.subscribe(() => {
      snapshots.push(diagnostics.get());
    });
    release.resolve();
    await vi.runAllTimersAsync();
    expect(snapshots.at(-1)).toBe(diagnostics.get());
    expect(diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision,
      unresolved: [],
    });
    expect(() => diagnostics.subscribe(() => {})).toThrow("disposed");
    expect(report).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await vi.runAllTimersAsync();
    await stopping;
  }
});
