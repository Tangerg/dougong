import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createHost, definePlugin, type AsyncDisposable } from "../src";

afterEach(() => vi.useRealTimers());

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

it("preserves a preparation failure and joins quarantine that begins during candidate cleanup", async () => {
  const candidateCleanupEntered = Promise.withResolvers<void>();
  const allowCandidateCleanup = Promise.withResolvers<void>();
  const independentCleanupEntered = Promise.withResolvers<void>();
  const allowIndependentCleanup = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<unknown>();
  const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
  const setupFailure = new Error("Candidate setup failed");
  const releaseFailure = new Error("Independent resource release failed");
  const releaseCandidate = vi.fn<() => Promise<void>>(async () => {
    candidateCleanupEntered.resolve();
    await allowCandidateCleanup.promise;
  });
  const releaseIndependent = vi.fn<() => Promise<void>>(async () => {
    independentCleanupEntered.resolve();
    await allowIndependentCleanup.promise;
  });
  const releaseFailed = vi.fn<() => never>(() => {
    throw releaseFailure;
  });
  const previousSetup = vi.fn<() => void>();
  let early!: AsyncDisposable;
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "releasing",
        plugin: definePlugin({
          name: "releasing",
          setup({ lifetime }) {
            early = lifetime.defer(releaseFailed);
          },
        }),
      },
      {
        id: "changing",
        plugin: definePlugin({ name: "changing", setup: previousSetup }),
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
  change.update(host.installation("changing")!, {
    plugin: definePlugin({
      name: "changing",
      setup({ lifetime }) {
        lifetime.defer(releaseCandidate);
        throw setupFailure;
      },
    }),
  });
  let operationSettled = false;
  const applying = host.apply(await host.plan(change)).catch((error: unknown) => error);
  void applying.then(() => {
    operationSettled = true;
  });
  await candidateCleanupEntered.promise;
  await expect(early[Symbol.asyncDispose]()).rejects.toBe(releaseFailure);
  await independentCleanupEntered.promise;
  allowCandidateCleanup.resolve();
  try {
    await setImmediate();
    expect(operationSettled).toBe(false);
    expect(host.status).toBe("quarantined");
    expect(host.stateRevision).toBe(revision + 1);
  } finally {
    allowIndependentCleanup.resolve();
  }
  const [failure, quarantine] = await Promise.all([applying, reported.promise]);
  expect(failure).toMatchObject({
    code: "HOST_QUARANTINED",
    details: {
      outcome: "quarantined",
      phase: "prepare",
      stateRevision: revision + 1,
      affectedInstallations: ["changing"],
    },
  });
  expect(containsCause(failure, setupFailure)).toBe(true);
  expect(containsCause(failure, quarantine)).toBe(true);
  expect(containsCause(failure, releaseFailure)).toBe(true);
  expect(releaseCandidate).toHaveBeenCalledOnce();
  expect(releaseIndependent).toHaveBeenCalledOnce();
  expect(releaseFailed).toHaveBeenCalledOnce();
  expect(previousSetup).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(host.stateRevision).toBe(revision + 1);
});

it("reuses the quarantine receipt when an interrupted change has no independent failure", async () => {
  const cleanupEntered = Promise.withResolvers<void>();
  const allowCleanup = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<unknown>();
  const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
  const releaseFailure = new Error("Independent resource release failed");
  const releaseChanging = vi.fn<() => Promise<void>>(async () => {
    cleanupEntered.resolve();
    await allowCleanup.promise;
  });
  const nextSetup = vi.fn<() => void>();
  let early!: AsyncDisposable;
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "releasing",
        plugin: definePlugin({
          name: "releasing",
          setup({ lifetime }) {
            early = lifetime.defer(() => {
              throw releaseFailure;
            });
          },
        }),
      },
      {
        id: "changing",
        plugin: definePlugin({
          name: "changing",
          setup({ lifetime }) {
            lifetime.defer(releaseChanging);
          },
        }),
      },
    ],
  });
  await host.start();
  const revision = host.stateRevision;
  const change = host.change();
  change.update(host.installation("changing")!, {
    plugin: definePlugin({ name: "changing", setup: nextSetup }),
  });
  const applying = host.apply(await host.plan(change)).catch((error: unknown) => error);
  await cleanupEntered.promise;
  await expect(early[Symbol.asyncDispose]()).rejects.toBe(releaseFailure);
  allowCleanup.resolve();
  const [failure, quarantine] = await Promise.all([applying, reported.promise]);
  expect(failure).toBe(quarantine);
  expect(containsCause(failure, releaseFailure)).toBe(true);
  expect(releaseChanging).toHaveBeenCalledOnce();
  expect(nextSetup).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
  expect(host.status).toBe("quarantined");
  expect(host.stateRevision).toBe(revision + 1);
});

it.each(["pending", "completed"] as const)(
  "preserves a new preparation failure when quarantine cleanup has %s work",
  async (quarantineWork) => {
    vi.useFakeTimers();
    const shutdownTimeoutMilliseconds = 10;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<unknown>();
    const report = vi.fn<(error: unknown) => void>((error) => reported.resolve(error));
    const releaseCandidate = vi.fn<() => void>();
    const setupFailure = new Error("Preparation failed after quarantine began");
    const releaseFailure = new Error("Early resource release failed");
    const releaseFailed = vi.fn<() => never>(() => {
      throw releaseFailure;
    });
    const previousSetup = vi.fn<() => void>();
    let early!: AsyncDisposable;
    const host = createHost({
      shutdownTimeoutMilliseconds,
      onError: report,
      installations: [
        {
          id: "releasing",
          plugin: definePlugin({
            name: "releasing",
            setup({ lifetime }) {
              early = lifetime.defer(releaseFailed);
            },
          }),
        },
        {
          id: "changing",
          plugin: definePlugin({ name: "changing", setup: previousSetup }),
        },
      ],
    });
    await host.start();
    const revision = host.stateRevision;
    const change = host.change();
    change.update(host.installation("changing")!, {
      plugin: definePlugin({
        name: "changing",
        async setup({ lifetime }) {
          lifetime.defer(releaseCandidate);
          entered.resolve();
          await resume.promise;
          throw setupFailure;
        },
      }),
    });
    const applying = host.apply(await host.plan(change)).catch((error: unknown) => error);
    await entered.promise;
    await expect(early[Symbol.asyncDispose]()).rejects.toBe(releaseFailure);
    if (quarantineWork === "completed") {
      await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
      await reported.promise;
    }
    resume.resolve();
    const [failure, quarantine] = await Promise.all([applying, reported.promise]);
    expect(failure).toMatchObject({
      code: "HOST_QUARANTINED",
      details: {
        outcome: "quarantined",
        phase: "prepare",
        stateRevision: revision + 1,
        affectedInstallations: ["changing"],
      },
    });
    expect(containsCause(failure, setupFailure)).toBe(true);
    expect(containsCause(failure, quarantine)).toBe(quarantineWork === "pending");
    expect(containsCause(quarantine, releaseFailure)).toBe(true);
    await vi.runAllTimersAsync();
    expect(releaseCandidate).toHaveBeenCalledOnce();
    expect(releaseFailed).toHaveBeenCalledOnce();
    expect(previousSetup).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(host.status).toBe("quarantined");
    expect(host.stateRevision).toBe(revision + 1);
  },
);
