import { expect, it, vi } from "vitest";
import {
  createHost,
  createResourceAuthority,
  definePlugin,
  DougongError,
  isCancellationReason,
  isRestoredCancellation,
} from "../src";

it("classifies only a restored transition caused by this caller's cancellation", () => {
  const reason = new Error("caller cancelled");
  const signal = AbortSignal.abort(reason);
  const restored = new DougongError("TRANSITION_FAILED", "startup cancelled", {
    cause: reason,
    details: { outcome: "restored" },
  });
  expect(isRestoredCancellation(signal, restored)).toBe(true);
  expect(isCancellationReason(signal, restored)).toBe(false);
  expect(isRestoredCancellation(new AbortController().signal, restored)).toBe(false);
  expect(isRestoredCancellation(AbortSignal.abort(new Error("other caller")), restored)).toBe(
    false,
  );
  const wrapped = new Error("SDK cancelled", { cause: reason });
  wrapped.name = "AbortError";
  expect(
    isRestoredCancellation(
      signal,
      new DougongError("TRANSITION_FAILED", "startup cancelled", {
        cause: wrapped,
        details: { outcome: "restored" },
      }),
    ),
  ).toBe(true);

  for (const failure of [
    reason,
    { code: "TRANSITION_FAILED", cause: reason, details: { outcome: "restored" } },
    new DougongError("HOST_QUARANTINED", "cleanup failed", {
      cause: reason,
      details: { outcome: "quarantined" },
    }),
    new DougongError("TRANSITION_FAILED", "not restored", { cause: reason }),
    new DougongError("OTHER_FAILURE", "unrelated failure", {
      cause: reason,
      details: { outcome: "restored" },
    }),
    new DougongError("TRANSITION_FAILED", "independent failure", {
      cause: new Error("setup failed"),
      details: { outcome: "restored" },
    }),
    new DougongError("TRANSITION_FAILED", "multiple failures", {
      cause: new AggregateError([reason, new Error("setup failed")]),
      details: { outcome: "restored" },
    }),
    new Error("outer failure", { cause: restored }),
    new AggregateError([restored, new Error("cleanup failed")]),
  ]) {
    expect(isRestoredCancellation(signal, failure)).toBe(false);
  }
  expect(() => isRestoredCancellation(null as never, restored)).toThrow(TypeError);
});

it("does not invoke rejection accessors or throw on an unreadable rejection", () => {
  const reason = new Error("caller cancelled");
  const signal = AbortSignal.abort(reason);
  for (const field of ["cause", "code", "details"] as const) {
    const failure = new DougongError("TRANSITION_FAILED", "untrusted error", {
      cause: reason,
      details: { outcome: "restored" },
    });
    const read = vi.fn<() => never>(() => {
      throw new Error("rejection accessor must not run");
    });
    Object.defineProperty(failure, field, { get: read });
    expect(isRestoredCancellation(signal, failure)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  }
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(isRestoredCancellation(signal, proxy)).toBe(false);
});

it.each([false, true])(
  "classifies startup only after its original setup and cleanup settle (cleanup failure: %s)",
  async (cleanupFails) => {
    const entered = Promise.withResolvers<void>();
    const setup = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupFailure = new Error("cleanup failed");
    const cleanup = vi.fn<() => Promise<void>>(async () => {
      cleaning.resolve();
      await release.promise;
      if (cleanupFails) throw cleanupFailure;
    });
    const host = createHost({
      resourceAuthority: createResourceAuthority(),
      onError() {},
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            async setup({ lifetime }) {
              lifetime.defer(cleanup);
              entered.resolve();
              await setup.promise;
            },
          }),
        },
      ],
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const settled = vi.fn<() => void>();
    const outcome = host.start(controller.signal).catch((error: unknown) => {
      settled();
      return error;
    });
    try {
      await entered.promise;
      controller.abort(reason);
      expect(settled).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      setup.resolve();
      await cleaning.promise;
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      const failure = await outcome;
      expect(isRestoredCancellation(controller.signal, failure)).toBe(!cleanupFails);
      expect(host.status).toBe(cleanupFails ? "quarantined" : "stopped");
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      setup.resolve();
      release.resolve();
      await outcome;
      if (host.status !== "quarantined") await host.stop();
    }
  },
);

it("preserves an independent setup rejection when cancellation overtakes it", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const independent = new Error("setup failed independently");
  const host = createHost({
    resourceAuthority: createResourceAuthority(),
    installations: [
      {
        id: "sample",
        plugin: definePlugin({
          name: "sample",
          async setup() {
            entered.resolve();
            await finish.promise;
            throw independent;
          },
        }),
      },
    ],
  });
  const controller = new AbortController();
  const outcome = host.start(controller.signal).catch((error: unknown) => error);
  try {
    await entered.promise;
    controller.abort(new Error("caller cancelled"));
    finish.resolve();
    const failure = await outcome;
    expect(failure).toMatchObject({
      code: "TRANSITION_FAILED",
      details: { outcome: "restored" },
      cause: independent,
    });
    expect(isRestoredCancellation(controller.signal, failure)).toBe(false);
  } finally {
    finish.resolve();
    await outcome;
    await host.stop();
  }
});
