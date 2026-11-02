import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createHost, definePlugin, type AsyncDisposable } from "../src";

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
