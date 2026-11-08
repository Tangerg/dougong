import { afterEach, expect, it, vi } from "vitest";
import { createHost, definePlugin, service, type ChildLifetime } from "../src";

afterEach(() => vi.useRealTimers());

const shutdownTimeoutMilliseconds = 10;
const rootShutdownDelayMilliseconds = 5;

it.each([
  { operation: "stop", finishBeforeRootDeadline: true },
  { operation: "update", finishBeforeRootDeadline: true },
  { operation: "stop", finishBeforeRootDeadline: false },
  { operation: "update", finishBeforeRootDeadline: false },
] as const)(
  "quarantines a child deadline during $operation (finishes before root deadline: $finishBeforeRootDeadline)",
  async ({ operation, finishBeforeRootDeadline }) => {
    vi.useFakeTimers();
    const value = service<number>("shutdown-deadline/provider");
    const release = Promise.withResolvers<void>();
    const report = vi.fn<(error: unknown) => void>();
    const releaseChild = vi.fn<() => Promise<void>>(() => release.promise);
    const releaseParent = vi.fn<() => void>();
    const releaseProvider = vi.fn<() => void>();
    const releaseIndependent = vi.fn<() => void>();
    const replacementSetup = vi.fn<() => void>();
    let child!: ChildLifetime;
    const host = createHost({
      shutdownTimeoutMilliseconds,
      onError: report,
      installations: [
        {
          id: "provider",
          plugin: definePlugin({
            name: "provider",
            provides: { value },
            setup({ lifetime }) {
              lifetime.defer(releaseProvider);
              return { value: 1 };
            },
          }),
        },
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            requires: { value },
            setup({ lifetime }) {
              lifetime.defer(releaseParent);
              child = lifetime.child("pending-child");
              child.defer(releaseChild);
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
    const change = host.change();
    change.update(host.installation("owner")!, {
      plugin: definePlugin({ name: "replacement", setup: replacementSetup }),
    });
    const replacement = await host.plan(change);
    const closingChild = child[Symbol.asyncDispose]().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(rootShutdownDelayMilliseconds);
    const transition = (operation === "stop" ? host.stop() : host.apply(replacement)).catch(
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(
        shutdownTimeoutMilliseconds - rootShutdownDelayMilliseconds,
      );
      expect(await closingChild).toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
      expect(host.status).toBe("quarantined");
      expect(host.stateRevision).toBe(revision + 1);
      expect(releaseIndependent).toHaveBeenCalledOnce();
      await expect(host.use(value, (current) => current)).rejects.toMatchObject({
        code: "HOST_QUARANTINED",
      });
      if (!finishBeforeRootDeadline) {
        await vi.advanceTimersByTimeAsync(rootShutdownDelayMilliseconds);
        await transition;
      }
      expect(releaseParent).not.toHaveBeenCalled();
      expect(releaseProvider).not.toHaveBeenCalled();
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(await transition).toMatchObject({ code: "HOST_QUARANTINED" });
      expect(host.status).toBe("quarantined");
      expect(host.stateRevision).toBe(revision + 1);
      expect(releaseChild).toHaveBeenCalledOnce();
      expect(releaseParent).toHaveBeenCalledOnce();
      expect(releaseProvider).toHaveBeenCalledOnce();
      expect(replacementSetup).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0]![0]).toMatchObject({ code: "HOST_QUARANTINED" });
      expect(host.diagnostics.get().unresolved).toEqual([]);
      await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
      await expect(host.apply(replacement)).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
      expect(host.stateRevision).toBe(revision + 1);
    } finally {
      release.resolve();
      await vi.runAllTimersAsync();
      await transition;
      if (host.status !== "quarantined") await host.stop();
    }
  },
);

it("preserves a nested deadline even when its rejection resumes cleanup before the root timer", async () => {
  vi.useFakeTimers();
  const release = Promise.withResolvers<void>();
  const report = vi.fn<(error: unknown) => void>();
  let child!: ChildLifetime;
  const host = createHost({
    shutdownTimeoutMilliseconds,
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            child = lifetime.child("nested");
            child.defer(() => release.promise);
          },
        }),
      },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const stopping = host.stop().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(0);
    const closingChild = child[Symbol.asyncDispose]().catch((error: unknown) => {
      release.resolve();
      return error;
    });
    await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
    expect(await closingChild).toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(await stopping).toMatchObject({ code: "HOST_QUARANTINED" });
    expect(host.diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision + 1,
      unresolved: [],
    });
    expect(report).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await vi.runAllTimersAsync();
    await stopping;
  }
});

it("returns a root deadline through its owning command without a second quarantine report", async () => {
  vi.useFakeTimers();
  const release = Promise.withResolvers<void>();
  const report = vi.fn<(error: unknown) => void>();
  const cleanup = vi.fn<() => Promise<void>>(() => release.promise);
  const host = createHost({
    shutdownTimeoutMilliseconds,
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            lifetime.defer(cleanup);
          },
        }),
      },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const stopping = host.stop().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
    expect(await stopping).toMatchObject({
      code: "HOST_QUARANTINED",
      details: { phase: "stop" },
    });
    expect(host.stateRevision).toBe(revision + 1);
    expect(report).not.toHaveBeenCalled();
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision + 1,
      unresolved: [],
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await vi.runAllTimersAsync();
    await stopping;
  }
});
