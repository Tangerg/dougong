import { expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  optional,
  service,
  type Disposable,
} from "../src/index";
import { Lifetime } from "../src/lifetime/lifetime";

const resourceAuthority = createResourceAuthority();

interface StorageResource extends Disposable {
  flush(): void;
}

it.each(["stop", "update", "remove"] as const)(
  "delivers an admitted acquisition before its provider is cancelled during %s",
  async (operation) => {
    const storage = service<{ begin(): void; flush(): Promise<void> }>("acquisition/storage");
    const opening = Promise.withResolvers<StorageResource>();
    const consumerEntered = Promise.withResolvers<void>();
    const trace: string[] = [];
    const signals: AbortSignal[] = [];
    const report = vi.fn<(error: unknown) => void>();
    const provider = definePlugin({
      name: "provider",
      provides: { storage },
      setup({ lifetime }) {
        signals.push(lifetime.signal);
        let result: Promise<{ resource: StorageResource } | { error: unknown }> | undefined;
        return {
          storage: {
            begin() {
              result = lifetime
                .acquire(() => opening.promise)
                .then(
                  (receipt) => receipt,
                  (error: unknown) => ({ error }),
                );
            },
            async flush() {
              if (!result) return;
              const outcome = await result;
              if ("error" in outcome) throw outcome.error;
              outcome.resource.flush();
            },
          },
        };
      },
    });
    const host = createHost({
      resourceAuthority,
      onError: report,
      installations: [
        { id: "provider", plugin: provider },
        {
          id: "consumer",
          plugin: definePlugin({
            name: "consumer",
            requires: { storage: optional(storage) },
            setup({ lifetime, dependencies }) {
              lifetime.defer(async () => {
                if (!dependencies.storage) return;
                trace.push("consumer cleanup entered");
                consumerEntered.resolve();
                await dependencies.storage.flush();
                trace.push("consumer cleanup complete");
              });
            },
          }),
        },
      ],
    });
    const resource: StorageResource = {
      flush() {
        trace.push("resource flushed");
      },
      [Symbol.dispose]() {
        trace.push("resource released");
      },
    };
    try {
      await host.start();
      await host.use(storage, (current) => current.begin());
      const signal = signals[0]!;
      const revision = host.stateRevision;
      const change = host.change();
      if (operation === "update")
        change.update(host.installation("provider")!, { plugin: provider });
      if (operation === "remove") change.remove(host.installation("provider")!);
      const transition = operation === "stop" ? host.stop() : host.apply(await host.plan(change));
      const result = transition.then(
        () => undefined,
        (error: unknown) => error,
      );
      await consumerEntered.promise;
      expect(signal.aborted).toBe(false);
      opening.resolve(resource);
      expect(await result).toBeUndefined();
      expect(trace).toEqual([
        "consumer cleanup entered",
        "resource flushed",
        "consumer cleanup complete",
        "resource released",
      ]);
      expect(signal.aborted).toBe(true);
      expect(host.status).toBe(operation === "stop" ? "stopped" : "running");
      expect(host.stateRevision).toBe(revision + 1);
      expect(host.diagnostics.get().unresolved).toEqual([]);
      expect(report).not.toHaveBeenCalled();
    } finally {
      opening.resolve(resource);
      await host.stop();
    }
  },
);

it("seals new work while delivering an already admitted acquisition to its Task", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const owner = new Lifetime({ resourceAuthority, label: "owner", report });
  const entered = Promise.withResolvers<void>();
  const opening = Promise.withResolvers<Disposable>();
  const release = vi.fn<() => void>();
  const resource = { [Symbol.dispose]: release };
  const task = owner.spawn(() =>
    owner.acquire(() => {
      entered.resolve();
      return opening.promise;
    }),
  );
  try {
    await entered.promise;
    owner.seal();
    const factory = vi.fn<() => Disposable>(() => resource);
    expect(() => owner.acquire(factory)).toThrow("closed to new work");
    expect(() => owner.spawn(factory)).toThrow("closed to new work");
    expect(factory).not.toHaveBeenCalled();
    expect(owner.signal.aborted).toBe(false);
    opening.resolve(resource);
    expect((await task.result).value.resource).toBe(resource);
    expect(owner.snapshot()).toMatchObject({
      phase: "sealed",
      cleanups: 1,
      acquisitions: 0,
      tasks: 0,
    });
    expect(report).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  } finally {
    opening.resolve(resource);
    await owner.dispose();
  }
  expect(release).toHaveBeenCalledOnce();
});

it("preserves a factory's independent AbortError instead of treating its name as cancellation", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const owner = new Lifetime({ resourceAuthority, label: "owner", report });
  const failure = new DOMException("independent factory failure", "AbortError");
  const task = owner.spawn(() => owner.acquire(() => Promise.reject(failure)));
  try {
    await expect(task.result).rejects.toBe(failure);
    expect(owner.signal.aborted).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(owner.snapshot()).toMatchObject({ cleanups: 0, acquisitions: 0, tasks: 0 });
  } finally {
    await owner.dispose();
  }
});

it("reclaims a genuinely cancelled acquisition once with its original cancellation reason", async () => {
  const report = vi.fn<(error: unknown) => void>();
  const owner = new Lifetime({ resourceAuthority, label: "owner", report });
  const entered = Promise.withResolvers<AbortSignal>();
  const opening = Promise.withResolvers<Disposable>();
  const release = vi.fn<() => void>();
  const resource = { [Symbol.dispose]: release };
  const task = owner.spawn((signal) => {
    entered.resolve(signal);
    return owner.acquire(() => opening.promise);
  });
  const outcome = task.result.catch((error: unknown) => error);
  const taskSignal = await entered.promise;
  const lifetimeSignal = owner.signal;
  const stopping = owner.dispose();
  opening.resolve(resource);
  expect(await outcome).toBe(lifetimeSignal.reason);
  expect(taskSignal.reason).toBe(lifetimeSignal.reason);
  await stopping;
  expect(release).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
  expect(owner.snapshot()).toMatchObject({ phase: "disposed", cleanups: 0, acquisitions: 0 });
});
