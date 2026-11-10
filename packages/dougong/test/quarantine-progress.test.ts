import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  service,
  type AsyncDisposable,
  type HostSnapshot,
} from "../src";

const resourceAuthority = createResourceAuthority();

afterEach(() => vi.useRealTimers());

const shutdownTimeoutMilliseconds = 10;

function containsCause(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((cause) => containsCause(cause, expected))
  )
    return true;
  return (
    error instanceof Error && error.cause !== undefined && containsCause(error.cause, expected)
  );
}

it("reports quarantine before a foreground borrow drains and then releases its independent owner once", async () => {
  const value = service<number>("quarantine-progress/borrowed");
  const resume = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<unknown>();
  const failure = new Error("early release failed");
  const releaseFailed = vi.fn<() => never>(() => {
    throw failure;
  });
  const releaseBorrowed = vi.fn<() => void>();
  const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
  let early!: AsyncDisposable;
  let borrowedSignal!: AbortSignal;
  const host = createHost({
    resourceAuthority,
    onError: report,
    installations: [
      {
        id: "failed",
        plugin: definePlugin({
          name: "failed",
          setup({ lifetime }) {
            early = lifetime.defer(releaseFailed);
          },
        }),
      },
      {
        id: "borrowed",
        plugin: definePlugin({
          name: "borrowed",
          provides: { value },
          setup({ lifetime }) {
            borrowedSignal = lifetime.signal;
            lifetime.defer(releaseBorrowed);
            return { value: 1 };
          },
        }),
      },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const borrowing = host.use(value, async () => {
    await resume.promise;
    expect(releaseBorrowed).not.toHaveBeenCalled();
  });
  try {
    await expect(early[Symbol.asyncDispose]()).rejects.toBe(failure);
    await expect(reported.promise).resolves.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(borrowedSignal.aborted).toBe(true);
    expect(releaseBorrowed).not.toHaveBeenCalled();
    expect(
      host.diagnostics.get().unresolved.find(({ installation }) => installation === "borrowed")
        ?.lifetime,
    ).toMatchObject({ phase: "disposing", foreground: 1 });
    await expect(host.use(value, () => undefined)).rejects.toMatchObject({
      code: "HOST_QUARANTINED",
    });

    resume.resolve();
    await borrowing;
    await setImmediate();
    expect(releaseBorrowed).toHaveBeenCalledOnce();
    expect(releaseFailed).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(host.diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision + 1,
      unresolved: [{ installation: "failed" }],
    });
    await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(releaseFailed).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
    await borrowing;
  }
});

it("cancels cooperative foreground work and joins its cancellation before destroying its resources", async () => {
  const operation = service<() => Promise<void>>("quarantine-progress/cancellable");
  const reported = Promise.withResolvers<unknown>();
  const cancelled = Promise.withResolvers<void>();
  const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
  let early!: AsyncDisposable;
  let signal!: AbortSignal;
  let exited = false;
  const release = vi.fn<() => void>(() => {
    expect(exited).toBe(true);
  });
  const cancel = vi.fn<() => void>(() => cancelled.reject(signal.reason));
  const host = createHost({
    resourceAuthority,
    onError: report,
    installations: [
      {
        id: "failed",
        plugin: definePlugin({
          name: "failed",
          setup({ lifetime }) {
            early = lifetime.defer(() => {
              throw new Error("early release failed");
            });
          },
        }),
      },
      {
        id: "cancellable",
        plugin: definePlugin({
          name: "cancellable",
          provides: { operation },
          setup({ lifetime }) {
            signal = lifetime.signal;
            lifetime.defer(release);
            return {
              async operation() {
                signal.addEventListener("abort", cancel, { once: true });
                try {
                  await cancelled.promise;
                } finally {
                  exited = true;
                }
              },
            };
          },
        }),
      },
    ],
  });
  await host.start();
  const borrowing = host.use(operation, (run) => run()).catch((error: unknown) => error);
  try {
    await expect(early[Symbol.asyncDispose]()).rejects.toThrow("early release failed");
    await reported.promise;
    expect(signal.aborted).toBe(true);
    expect(await borrowing).toBe(signal.reason);
    await setImmediate();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(host.diagnostics.get().unresolved.map(({ installation }) => installation)).toEqual([
      "failed",
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancelled.resolve();
    await borrowing;
  }
});

it("keeps transitive providers usable until a timed-out consumer really exits and then finishes retirement", async () => {
  vi.useFakeTimers();
  const root = service<() => void>("quarantine-progress/root");
  const provider = service<() => void>("quarantine-progress/provider");
  const resume = Promise.withResolvers<void>();
  const released: string[] = [];
  const report = vi.fn<(error: unknown) => void>();
  const releaseConsumer = vi.fn<() => Promise<void>>();
  let rootSignal!: AbortSignal;
  let providerSignal!: AbortSignal;
  const host = createHost({
    resourceAuthority,
    shutdownTimeoutMilliseconds,
    onError: report,
    installations: [
      {
        id: "root",
        plugin: definePlugin({
          name: "root",
          provides: { root },
          setup({ lifetime }) {
            rootSignal = lifetime.signal;
            lifetime.defer(() => {
              released.push("root");
            });
            return { root: () => expect(rootSignal.aborted).toBe(false) };
          },
        }),
      },
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { provider },
          requires: { root },
          setup({ lifetime, dependencies }) {
            providerSignal = lifetime.signal;
            lifetime.defer(() => {
              dependencies.root();
              released.push("provider");
            });
            return {
              provider() {
                expect(providerSignal.aborted).toBe(false);
                dependencies.root();
              },
            };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { provider },
          setup({ lifetime, dependencies }) {
            releaseConsumer.mockImplementation(async () => {
              dependencies.provider();
              await resume.promise;
              dependencies.provider();
              released.push("consumer");
            });
            lifetime.defer(releaseConsumer);
          },
        }),
      },
    ],
  });
  await host.start();
  const stopping = host.stop().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
    expect(await stopping).toMatchObject({ code: "HOST_QUARANTINED" });
    const revision = host.stateRevision;
    expect(released).toEqual([]);
    expect(rootSignal.aborted).toBe(false);
    expect(providerSignal.aborted).toBe(false);
    const snapshots: HostSnapshot[] = [];
    using _subscription = host.diagnostics.subscribe(() => {
      snapshots.push(host.diagnostics.get());
    });

    resume.resolve();
    await vi.runAllTimersAsync();
    expect(released).toEqual(["consumer", "provider", "root"]);
    expect(releaseConsumer).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(rootSignal.aborted).toBe(true);
    expect(providerSignal.aborted).toBe(true);
    expect(host.diagnostics.get()).toMatchObject({
      status: "quarantined",
      stateRevision: revision,
      unresolved: [],
    });
    expect(snapshots.at(-1)).toBe(host.diagnostics.get());
    expect(() => host.diagnostics.subscribe(() => undefined)).toThrow("disposed");
    await expect(host.start()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(released).toEqual(["consumer", "provider", "root"]);
  } finally {
    resume.resolve();
    await vi.runAllTimersAsync();
    await stopping;
  }
});

it.each(["consumer", "provider"] as const)(
  "reports a late %s cleanup failure once and retains the providers it still owns",
  async (failing) => {
    vi.useFakeTimers();
    const root = service<number>("quarantine-progress/failure-root");
    const provider = service<number>("quarantine-progress/failure-provider");
    const resume = Promise.withResolvers<void>();
    const failure = new Error(failing + " failed after the deadline");
    const releaseRoot = vi.fn<() => void>();
    const releaseProvider = vi.fn<() => void>(() => {
      if (failing === "provider") throw failure;
    });
    const releaseConsumer = vi.fn<() => Promise<void>>(async () => {
      await resume.promise;
      if (failing === "consumer") throw failure;
    });
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({
      resourceAuthority,
      shutdownTimeoutMilliseconds,
      onError: report,
      installations: [
        {
          id: "root",
          plugin: definePlugin({
            name: "root",
            provides: { root },
            setup({ lifetime }) {
              lifetime.defer(releaseRoot);
              return { root: 1 };
            },
          }),
        },
        {
          id: "provider",
          plugin: definePlugin({
            name: "provider",
            requires: { root },
            provides: { provider },
            setup({ lifetime, dependencies }) {
              lifetime.defer(releaseProvider);
              return { provider: dependencies.root };
            },
          }),
        },
        {
          id: "consumer",
          plugin: definePlugin({
            name: "consumer",
            requires: { provider },
            setup({ lifetime }) {
              lifetime.defer(releaseConsumer);
            },
          }),
        },
      ],
    });
    await host.start();
    const stopping = host.stop().catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
      expect(await stopping).toMatchObject({ code: "HOST_QUARANTINED" });
      const revision = host.stateRevision;
      expect(report).not.toHaveBeenCalled();
      expect(releaseProvider).not.toHaveBeenCalled();
      resume.resolve();
      await vi.runAllTimersAsync();
      expect(report).toHaveBeenCalledOnce();
      expect(containsCause(report.mock.calls[0]![0], failure)).toBe(true);
      expect(report.mock.calls[0]![0]).toMatchObject({
        code: "HOST_QUARANTINED",
        details: { phase: "release", stateRevision: revision, affectedInstallations: [failing] },
      });
      expect(releaseConsumer).toHaveBeenCalledOnce();
      expect(releaseProvider).toHaveBeenCalledTimes(failing === "provider" ? 1 : 0);
      expect(releaseRoot).not.toHaveBeenCalled();
      const snapshot = host.diagnostics.get();
      expect(snapshot.status).toBe("quarantined");
      expect(snapshot.stateRevision).toBe(revision);
      expect(snapshot.unresolved.map(({ installation }) => installation)).toEqual(
        failing === "consumer" ? ["root", "provider", "consumer"] : ["root", "provider"],
      );
      expect(JSON.stringify(snapshot.error)).toContain("SHUTDOWN_TIMEOUT");
      expect(JSON.stringify(snapshot.error)).toContain(failure.message);
      await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
      expect(releaseConsumer).toHaveBeenCalledOnce();
      expect(releaseProvider).toHaveBeenCalledTimes(failing === "provider" ? 1 : 0);
      expect(report).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
      await vi.runAllTimersAsync();
      await stopping;
    }
  },
);

it("preserves a deferred branch's failure when the first quarantine report is still joining other cleanup", async () => {
  const value = service<number>("quarantine-progress/deferred-failure");
  const resumeBorrow = Promise.withResolvers<void>();
  const resumeCleanup = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const deferredReported = Promise.withResolvers<unknown>();
  const initialReported = Promise.withResolvers<unknown>();
  const initialFailure = new Error("early cleanup failed");
  const deferredFailure = new Error("borrowed cleanup failed");
  const releaseBorrowed = vi.fn<() => never>(() => {
    throw deferredFailure;
  });
  let early!: AsyncDisposable;
  const report = vi.fn<(error: unknown) => void>((error) => {
    if (containsCause(error, deferredFailure)) deferredReported.resolve(error);
    if (containsCause(error, initialFailure)) initialReported.resolve(error);
  });
  const host = createHost({
    resourceAuthority,
    onError: report,
    installations: [
      {
        id: "failed",
        plugin: definePlugin({
          name: "failed",
          setup({ lifetime }) {
            early = lifetime.defer(() => {
              throw initialFailure;
            });
          },
        }),
      },
      {
        id: "borrowed",
        plugin: definePlugin({
          name: "borrowed",
          provides: { value },
          setup({ lifetime }) {
            lifetime.defer(releaseBorrowed);
            return { value: 1 };
          },
        }),
      },
      {
        id: "cleaning",
        plugin: definePlugin({
          name: "cleaning",
          setup({ lifetime }) {
            lifetime.defer(async () => {
              cleanupEntered.resolve();
              await resumeCleanup.promise;
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const borrowing = host.use(value, () => resumeBorrow.promise);
  try {
    await expect(early[Symbol.asyncDispose]()).rejects.toBe(initialFailure);
    const revision = host.stateRevision;
    await cleanupEntered.promise;
    resumeBorrow.resolve();
    await borrowing;
    await deferredReported.promise;
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.stringify(host.diagnostics.get().error)).toContain(deferredFailure.message);

    resumeCleanup.resolve();
    await initialReported.promise;
    expect(report).toHaveBeenCalledTimes(2);
    expect(releaseBorrowed).toHaveBeenCalledOnce();
    expect(host.stateRevision).toBe(revision);
    expect(JSON.stringify(host.diagnostics.get().error)).toContain(deferredFailure.message);
    expect(JSON.stringify(host.diagnostics.get().error)).toContain(initialFailure.message);
  } finally {
    resumeBorrow.resolve();
    resumeCleanup.resolve();
    await borrowing;
  }
});
