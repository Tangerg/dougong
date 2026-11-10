import { describe, expect, it, vi } from "vitest";
import { createHost, createResourceAuthority, definePlugin, service } from "../src";
import { onAbort } from "../src/advanced";

const resourceAuthority = createResourceAuthority();

function untilCancelled(signal: AbortSignal) {
  return new Promise<void>((resolve) => onAbort(signal, () => resolve()));
}

describe("execution cancellation", () => {
  it("rejects cancelled startup before validation or setup", async () => {
    const setup = vi.fn<() => void>();
    const validate = vi.fn<() => { value: undefined }>(() => ({ value: undefined }));
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            configuration: { "~standard": { version: 1, vendor: "test", validate } },
            setup,
          }),
        },
      ],
    });
    const reason = new Error("cancelled before startup");
    await expect(host.start(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(validate).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(host.status).toBe("stopped");
    expect(host.stateRevision).toBe(0);
  });

  it("does not consume a Plan whose execution was cancelled while queued", async () => {
    const host = createHost({ resourceAuthority });
    const change = host.change();
    change.install(definePlugin({ name: "sample", setup() {} }), { id: "sample" });
    const plan = await host.plan(change);
    const controller = new AbortController();
    const applying = host.apply(plan, controller.signal);
    controller.abort();
    await expect(applying).rejects.toBe(controller.signal.reason);
    expect(host.installation("sample")).toBeUndefined();
    await host.apply(plan);
    expect(host.installation("sample")?.status).toBe("stopped");
  });

  it("cancels startup validation and rejects its late result without running setup", async () => {
    const entered = Promise.withResolvers<void>();
    const validation = Promise.withResolvers<{ value: undefined }>();
    const setup = vi.fn<() => void>();
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            configuration: {
              "~standard": {
                version: 1,
                vendor: "test",
                validate() {
                  entered.resolve();
                  return validation.promise;
                },
              },
            },
            setup,
          }),
        },
      ],
    });
    const controller = new AbortController();
    const starting = host.start(controller.signal);
    const reason = new Error("cancel startup validation");
    const outcome = starting.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(host.status).toBe("stopped");
    validation.resolve({ value: undefined });
    await validation.promise;
    expect(setup).not.toHaveBeenCalled();
    expect(host.stateRevision).toBe(0);
  });

  it("delivers cancellation to setup and joins cleanup before returning", async () => {
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let returned = false;
    const cleanup = vi.fn<() => Promise<void>>(async () => {
      cleaning.resolve();
      await release.promise;
    });
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            async setup({ lifetime }) {
              lifetime.defer(cleanup);
              entered.resolve();
              await untilCancelled(lifetime.signal);
            },
          }),
        },
      ],
    });
    const controller = new AbortController();
    const starting = host.start(controller.signal);
    const outcome = starting.catch((error: unknown) => error);
    void starting.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    await entered.promise;
    controller.abort();
    await cleaning.promise;
    expect(returned).toBe(false);
    expect(host.status).toBe("starting");
    release.resolve();
    expect(await outcome).toMatchObject({
      code: "TRANSITION_FAILED",
      details: { outcome: "restored", phase: "prepare" },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(host.status).toBe("stopped");
    expect(host.stateRevision).toBe(0);
    expect(host.diagnostics.get().unresolved).toEqual([]);
  });

  it("reconstructs the previous execution after a replacement is cancelled", async () => {
    const value = service<number>("cancellation/value");
    const events: string[] = [];
    let generation = 0;
    const original = definePlugin({
      name: "sample",
      provides: { value },
      setup({ lifetime }) {
        const current = ++generation;
        events.push(`setup:${current}`);
        lifetime.defer(() => {
          events.push(`release:${current}`);
        });
        return { value: current };
      },
    });
    const entered = Promise.withResolvers<void>();
    const replacement = definePlugin({
      name: "replacement",
      provides: { value },
      async setup({ lifetime }) {
        lifetime.defer(() => {
          events.push("release:candidate");
        });
        entered.resolve();
        await untilCancelled(lifetime.signal);
        return { value: 99 };
      },
    });
    const host = createHost({
      resourceAuthority,
      installations: [{ id: "sample", plugin: original }],
    });
    await host.start();
    const revision = host.stateRevision;
    const change = host.change();
    change.update(host.installation("sample")!, { plugin: replacement });
    const controller = new AbortController();
    const plan = await host.plan(change);
    const applying = host.apply(plan, controller.signal);
    const outcome = applying.catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    expect(await outcome).toMatchObject({
      code: "TRANSITION_FAILED",
      details: { outcome: "restored", phase: "prepare" },
    });
    expect(events).toEqual(["setup:1", "release:1", "release:candidate", "setup:2"]);
    expect((await host.use(value, (current) => current)).value).toBe(2);
    expect(host.status).toBe("running");
    expect(host.stateRevision).toBe(revision + 1);
    await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_CONSUMED" });
    await host.stop();
  });

  it("retains a prepared provider until its cancelled consumer finishes cleanup", async () => {
    const value = service<number>("cancellation/provider");
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup: string[] = [];
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "provider",
          plugin: definePlugin({
            name: "provider",
            provides: { value },
            setup({ lifetime }) {
              lifetime.defer(() => {
                cleanup.push("provider");
              });
              return { value: 1 };
            },
          }),
        },
        {
          id: "consumer",
          plugin: definePlugin({
            name: "consumer",
            requires: { value },
            async setup({ lifetime }) {
              lifetime.defer(async () => {
                cleaning.resolve();
                await release.promise;
                cleanup.push("consumer");
              });
              entered.resolve();
              await untilCancelled(lifetime.signal);
            },
          }),
        },
      ],
    });
    const controller = new AbortController();
    const outcome = host.start(controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    await cleaning.promise;
    expect(cleanup).toEqual([]);
    release.resolve();
    expect(await outcome).toMatchObject({ code: "TRANSITION_FAILED" });
    expect(cleanup).toEqual(["consumer", "provider"]);
  });

  it("quarantines non-cooperative setup without forgetting its retained obligations", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const cleanup = vi.fn<() => void>(() => {
      cleaned.resolve();
    });
    const host = createHost({
      resourceAuthority,
      shutdownTimeoutMilliseconds: 1,
      onError() {},
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            async setup({ lifetime }) {
              lifetime.defer(cleanup);
              entered.resolve();
              await release.promise;
            },
          }),
        },
      ],
    });
    const controller = new AbortController();
    const outcome = host.start(controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    try {
      expect(await outcome).toMatchObject({
        code: "HOST_QUARANTINED",
        details: { outcome: "quarantined" },
      });
      expect(host.status).toBe("quarantined");
      expect(host.diagnostics.get().unresolved).toHaveLength(1);
      expect(cleanup).not.toHaveBeenCalled();
      const revision = host.stateRevision;
      release.resolve();
      await cleaned.promise;
      await vi.waitFor(() => expect(host.diagnostics.get().unresolved).toEqual([]));
      expect(host.status).toBe("quarantined");
      expect(host.stateRevision).toBe(revision);
    } finally {
      release.resolve();
    }
  });

  it("keeps a committed outcome when a publication observer cancels the caller", async () => {
    const controller = new AbortController();
    const host = createHost({
      resourceAuthority,
      installations: [{ id: "sample", plugin: definePlugin({ name: "sample", setup() {} }) }],
    });
    const subscription = host.diagnostics.subscribe(() => {
      if (host.status === "running") controller.abort();
    });
    await host.start(controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(host.status).toBe("running");
    expect(host.installation("sample")?.status).toBe("running");
    subscription[Symbol.dispose]();
    await host.stop();
  });
});

describe("execution restoration deadlines", () => {
  it("quarantines an expired restoration and retains its actual work until late settlement", async () => {
    vi.useFakeTimers();
    const restorationTimeoutMilliseconds = 10;
    const shutdownTimeoutMilliseconds = 5;
    const value = service<number>("restoration-deadline/value");
    const candidateEntered = Promise.withResolvers<void>();
    const restorationEntered = Promise.withResolvers<AbortSignal>();
    const releaseRestoration = Promise.withResolvers<void>();
    const restorationCleaned = Promise.withResolvers<void>();
    const cleanup = vi.fn<() => void>(() => restorationCleaned.resolve());
    let generation = 0;
    const original = definePlugin({
      name: "original",
      provides: { value },
      async setup({ lifetime }) {
        generation += 1;
        if (generation > 1) {
          lifetime.defer(cleanup);
          restorationEntered.resolve(lifetime.signal);
          await releaseRestoration.promise;
        }
        return { value: generation };
      },
    });
    const host = createHost({
      resourceAuthority,
      restorationTimeoutMilliseconds,
      shutdownTimeoutMilliseconds,
      onError() {},
      installations: [{ id: "sample", plugin: original }],
    });
    let outcome: Promise<unknown> | undefined;
    try {
      await host.start();
      const change = host.change();
      change.update(host.installation("sample")!, {
        plugin: definePlugin({
          name: "replacement",
          provides: { value },
          async setup({ lifetime }) {
            candidateEntered.resolve();
            await untilCancelled(lifetime.signal);
            return { value: 99 };
          },
        }),
      });
      const controller = new AbortController();
      outcome = host
        .apply(await host.plan(change), controller.signal)
        .catch((error: unknown) => error);
      await candidateEntered.promise;
      controller.abort();
      const restorationSignal = await restorationEntered.promise;
      expect(restorationSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(restorationTimeoutMilliseconds);
      expect(restorationSignal.aborted).toBe(true);
      expect(restorationSignal.reason).toBeInstanceOf(DOMException);
      expect(restorationSignal.reason).toMatchObject({ name: "TimeoutError" });
      expect(cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(shutdownTimeoutMilliseconds);
      expect(await outcome).toMatchObject({
        code: "HOST_QUARANTINED",
        details: { outcome: "quarantined", phase: "restore" },
      });
      expect(host.status).toBe("quarantined");
      expect(host.diagnostics.get().unresolved).toHaveLength(1);
      expect(cleanup).not.toHaveBeenCalled();
      const revision = host.stateRevision;

      releaseRestoration.resolve();
      await restorationCleaned.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(host.diagnostics.get().unresolved).toEqual([]);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(host.status).toBe("quarantined");
      expect(host.stateRevision).toBe(revision);
    } finally {
      releaseRestoration.resolve();
      try {
        await outcome;
        if (host.status === "running") await host.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("does not apply the restoration budget to ordinary startup", async () => {
    vi.useFakeTimers();
    const restorationTimeoutMilliseconds = 10;
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const host = createHost({
      resourceAuthority,
      restorationTimeoutMilliseconds,
      installations: [
        {
          id: "sample",
          plugin: definePlugin({
            name: "sample",
            async setup({ lifetime }) {
              entered.resolve(lifetime.signal);
              await release.promise;
            },
          }),
        },
      ],
    });
    let settled = false;
    const starting = host.start().then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      const signal = await entered.promise;
      await vi.advanceTimersByTimeAsync(restorationTimeoutMilliseconds * 2);
      expect(settled).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(host.status).toBe("starting");
      release.resolve();
      expect(await starting).toMatchObject({ result: { affectedInstallations: ["sample"] } });
      expect(host.status).toBe("running");
    } finally {
      release.resolve();
      try {
        await starting;
        if (host.status === "running") await host.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("restores with an independent signal and closes the budget before publishing healthy execution", async () => {
    vi.useFakeTimers();
    const restorationTimeoutMilliseconds = 10;
    const value = service<number>("healthy-restoration/value");
    const candidateEntered = Promise.withResolvers<void>();
    const restorationEntered = Promise.withResolvers<AbortSignal>();
    const releaseRestoration = Promise.withResolvers<void>();
    let generation = 0;
    const original = definePlugin({
      name: "original",
      provides: { value },
      async setup({ lifetime }) {
        generation += 1;
        if (generation > 1) {
          restorationEntered.resolve(lifetime.signal);
          await releaseRestoration.promise;
        }
        return { value: generation };
      },
    });
    const host = createHost({
      resourceAuthority,
      restorationTimeoutMilliseconds,
      installations: [{ id: "sample", plugin: original }],
    });
    let outcome: Promise<unknown> | undefined;
    try {
      await host.start();
      const change = host.change();
      change.update(host.installation("sample")!, {
        plugin: definePlugin({
          name: "replacement",
          provides: { value },
          async setup({ lifetime }) {
            candidateEntered.resolve();
            await untilCancelled(lifetime.signal);
            return { value: 99 };
          },
        }),
      });
      const controller = new AbortController();
      outcome = host
        .apply(await host.plan(change), controller.signal)
        .catch((error: unknown) => error);
      await candidateEntered.promise;
      controller.abort();
      const restorationSignal = await restorationEntered.promise;
      expect(controller.signal.aborted).toBe(true);
      expect(restorationSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(restorationTimeoutMilliseconds / 2);
      releaseRestoration.resolve();
      expect(await outcome).toMatchObject({
        code: "TRANSITION_FAILED",
        details: { outcome: "restored", phase: "prepare" },
      });
      expect((await host.use(value, (current) => current)).value).toBe(2);

      await vi.advanceTimersByTimeAsync(restorationTimeoutMilliseconds * 2);
      expect(restorationSignal.aborted).toBe(false);
      expect(host.status).toBe("running");
      expect(host.diagnostics.get().unresolved).toEqual([]);
    } finally {
      releaseRestoration.resolve();
      try {
        await outcome;
        if (host.status === "running") await host.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
