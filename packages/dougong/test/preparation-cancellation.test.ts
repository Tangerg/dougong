import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createHost, definePlugin, service, type AsyncDisposable } from "../src";

afterEach(() => vi.useRealTimers());

it.each(["start", "change"] as const)(
  "keeps prepared transitive dependencies available during failed %s cleanup",
  async (operation) => {
    const storage = service<() => void>("preparation/storage");
    const flush = service<() => void>("preparation/flush");
    const dependencyCalls: Array<{ readonly owner: string; readonly aborted: boolean }> = [];
    const released: string[] = [];
    const setupFailure = new Error("consumer setup failed");
    const storageProvider = definePlugin({
      name: "storage",
      provides: { storage },
      setup({ lifetime }) {
        const signal = lifetime.signal;
        lifetime.defer(() => {
          released.push("storage");
        });
        return {
          storage() {
            dependencyCalls.push({ owner: "storage", aborted: signal.aborted });
            signal.throwIfAborted();
          },
        };
      },
    });
    const buffer = definePlugin({
      name: "buffer",
      requires: { storage },
      provides: { flush },
      setup({ lifetime, dependencies }) {
        const signal = lifetime.signal;
        lifetime.defer(() => {
          dependencies.storage();
          released.push("buffer");
        });
        return {
          flush() {
            dependencyCalls.push({ owner: "buffer", aborted: signal.aborted });
            signal.throwIfAborted();
            dependencies.storage();
          },
        };
      },
    });
    const createConsumer = (fail: boolean) =>
      definePlugin({
        name: fail ? "failing-consumer" : "consumer",
        requires: { flush },
        setup({ lifetime, dependencies }) {
          lifetime.defer(() => {
            dependencies.flush();
            released.push("consumer");
          });
          if (fail) throw setupFailure;
        },
      });
    const host = createHost({
      installations: [
        { id: "storage", plugin: storageProvider },
        { id: "buffer", plugin: buffer },
        { id: "consumer", plugin: createConsumer(operation === "start") },
      ],
    });
    try {
      let failed: Promise<unknown>;
      if (operation === "start") failed = host.start();
      else {
        await host.start();
        const change = host.change();
        change.update(host.installation("storage")!, { plugin: storageProvider });
        change.update(host.installation("consumer")!, { plugin: createConsumer(true) });
        failed = host.apply(await host.plan(change));
      }
      await expect(failed).rejects.toMatchObject({
        code: "TRANSITION_FAILED",
        details: { phase: "prepare", outcome: "restored" },
        cause: setupFailure,
      });
      const releaseOrder = ["consumer", "buffer", "storage"];
      expect(released).toEqual(
        operation === "start" ? releaseOrder : [...releaseOrder, ...releaseOrder],
      );
      expect(dependencyCalls).not.toContainEqual(expect.objectContaining({ aborted: true }));
      expect(host.status).toBe(operation === "start" ? "stopped" : "running");
      if (operation === "change") await host.use(flush, (flushBuffer) => flushBuffer());
    } finally {
      if (host.status !== "quarantined") await host.stop();
    }
  },
);

it("releases prepared dependencies when restoration setup also fails", async () => {
  const flush = service<() => void>("preparation/restoration-flush");
  const replacementFailure = new Error("replacement failed");
  const restorationFailure = new Error("restoration failed");
  const released: string[] = [];
  let originalPreparations = 0;
  const provider = definePlugin({
    name: "provider",
    provides: { flush },
    setup({ lifetime }) {
      const signal = lifetime.signal;
      lifetime.defer(() => {
        released.push("provider");
      });
      return { flush: () => signal.throwIfAborted() };
    },
  });
  const original = definePlugin({
    name: "original",
    requires: { flush },
    setup({ lifetime, dependencies }) {
      lifetime.defer(() => {
        dependencies.flush();
        released.push("original");
      });
      if (++originalPreparations > 1) throw restorationFailure;
    },
  });
  const host = createHost({
    installations: [
      { id: "provider", plugin: provider },
      { id: "consumer", plugin: original },
    ],
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("provider")!, { plugin: provider });
  change.update(host.installation("consumer")!, {
    plugin: definePlugin({
      name: "replacement",
      requires: { flush },
      setup({ lifetime, dependencies }) {
        lifetime.defer(() => {
          dependencies.flush();
          released.push("replacement");
        });
        throw replacementFailure;
      },
    }),
  });
  await expect(host.apply(await host.plan(change))).rejects.toMatchObject({
    code: "HOST_QUARANTINED",
    details: { phase: "restore", outcome: "quarantined" },
    cause: { errors: [replacementFailure, restorationFailure] },
  });
  expect(originalPreparations).toBe(2);
  expect(released).toEqual([
    "original",
    "provider",
    "replacement",
    "provider",
    "original",
    "provider",
  ]);
  expect(host.diagnostics.get()).toMatchObject({ status: "quarantined", unresolved: [] });
  await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
});

it("retains prepared providers after a peer's shutdown deadline until its setup settles", async () => {
  vi.useFakeTimers();
  const shutdownTimeoutMilliseconds = 10;
  const flush = service<() => void>("preparation/deferred-flush");
  const setupFailure = new Error("peer setup failed");
  const peerEntered = Promise.withResolvers<void>();
  const peerCancelled = Promise.withResolvers<void>();
  const finishPeer = Promise.withResolvers<void>();
  const released: string[] = [];
  let providerSignal!: AbortSignal;
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    shutdownTimeoutMilliseconds,
    onError: report,
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { flush },
          setup({ lifetime }) {
            providerSignal = lifetime.signal;
            lifetime.defer(() => {
              released.push("provider");
            });
            return { flush: () => providerSignal.throwIfAborted() };
          },
        }),
      },
      {
        id: "failing",
        plugin: definePlugin({
          name: "failing",
          requires: { flush },
          async setup() {
            await peerEntered.promise;
            throw setupFailure;
          },
        }),
      },
      {
        id: "waiting",
        plugin: definePlugin({
          name: "waiting",
          requires: { flush },
          async setup({ lifetime, dependencies }) {
            lifetime.defer(() => {
              dependencies.flush();
              released.push("waiting");
            });
            lifetime.signal.addEventListener("abort", () => peerCancelled.resolve(), {
              once: true,
            });
            peerEntered.resolve();
            await finishPeer.promise;
          },
        }),
      },
    ],
  });
  const starting = host.start().catch((error: unknown) => error);
  try {
    await peerCancelled.promise;
    expect(providerSignal.aborted).toBe(false);
    expect(released).toEqual([]);
    await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
    expect(await starting).toMatchObject({ code: "HOST_QUARANTINED" });
    const revision = host.stateRevision;
    expect(providerSignal.aborted).toBe(false);
    expect(released).toEqual([]);
    expect(host.diagnostics.get().unresolved.map((entry) => entry.installation)).toEqual([
      "provider",
      "waiting",
    ]);

    finishPeer.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual(["waiting", "provider"]);
    expect(providerSignal.aborted).toBe(true);
    expect(host.diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision,
      unresolved: [],
    });
    expect(report).not.toHaveBeenCalled();
    await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  } finally {
    finishPeer.resolve();
    await vi.runAllTimersAsync();
    await starting;
    if (host.status !== "quarantined") await host.stop();
  }
});

it.each([false, true])(
  "distinguishes late setup cancellation from independent failure after quarantine (failure: %s)",
  async (independentFailure) => {
    const cleanupFailure = new Error("early cleanup failed");
    const lateFailure = new Error("independent late setup failure");
    const firstEntered = Promise.withResolvers<void>();
    const laterEntered = Promise.withResolvers<void>();
    const laterCancelled = Promise.withResolvers<void>();
    const finishLater = Promise.withResolvers<void>();
    const report = vi.fn<(error: unknown) => void>();
    let release!: AsyncDisposable;
    const host = createHost({
      onError: report,
      installations: [
        {
          id: "cleanup-owner",
          plugin: definePlugin({
            name: "cleanup-owner",
            setup({ lifetime }) {
              release = lifetime.defer(() => {
                throw cleanupFailure;
              });
            },
          }),
        },
        {
          id: "first-setup",
          plugin: definePlugin({
            name: "first-setup",
            setup({ lifetime }) {
              const signal = lifetime.signal;
              firstEntered.resolve();
              return new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          }),
        },
        {
          id: "later-setup",
          plugin: definePlugin({
            name: "later-setup",
            async setup({ lifetime }) {
              const signal = lifetime.signal;
              laterEntered.resolve();
              const reason = await new Promise<unknown>((resolve) => {
                signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
              });
              laterCancelled.resolve();
              await finishLater.promise;
              throw independentFailure ? lateFailure : reason;
            },
          }),
        },
      ],
    });
    const starting = Promise.allSettled([host.start()]);
    try {
      await Promise.all([firstEntered.promise, laterEntered.promise]);
      await expect(release[Symbol.asyncDispose]()).rejects.toBe(cleanupFailure);
      await laterCancelled.promise;
      // The first rejection must leave preparation before the delayed result settles.
      await setImmediate();
      expect(host.status).toBe("quarantined");
      finishLater.resolve();
      await expect(starting).resolves.toMatchObject([
        { status: "rejected", reason: { code: "HOST_QUARANTINED" } },
      ]);
      await setImmediate();
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "HOST_QUARANTINED" }));
      expect(report).toHaveBeenCalledTimes(independentFailure ? 2 : 1);
      expect(report.mock.calls.some(([error]) => error === lateFailure)).toBe(independentFailure);
    } finally {
      finishLater.resolve();
      await Promise.allSettled([host.stop()]);
      await starting;
    }
  },
);
