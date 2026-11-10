import { createResourceAuthority } from "dougong";
import { expect, it, vi } from "vitest";
import { extensionPoint } from "../src/contracts/contracts";
import type { Resource } from "../src/contracts/resource";
import { ContributionRegistry } from "../src/contributions/contribution-registry";
import { EventHub } from "../src/events/event-hub";
import { Lifetime } from "../src/lifetime/lifetime";

const resourceAuthority = createResourceAuthority();

const adoptionMethods = ["use", "own", "acquire"] as const;

async function rejectAdoption(
  owner: Lifetime,
  method: (typeof adoptionMethods)[number],
  handle: Resource,
) {
  await expect(async () => {
    if (method === "acquire") await owner.acquire(() => handle);
    else owner[method](handle);
  }).rejects.toThrow(TypeError);
}

it.each(adoptionMethods)(
  "rejects active and terminal control handles through %s without advancing their owners",
  async (method) => {
    const owner = new Lifetime({ resourceAuthority, label: "owner", report() {} });
    const other = new Lifetime({ resourceAuthority, label: "other", report() {} });
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<void>();
    const cleanup = vi.fn<() => void>();
    const interrupt = vi.fn<() => void>();
    const listener = vi.fn<() => void>();
    const task = owner.spawn(async (signal) => {
      entered.resolve(signal);
      await finish.promise;
    });
    const deferred = owner.defer(cleanup);
    const interruption = owner.interrupt(interrupt);
    const hub = new EventHub();
    const subscription = hub.stage("owned/notice", listener, owner);
    const store = new ContributionRegistry(() => undefined).store<number>(
      extensionPoint<number>("owned/items"),
    );
    const contribution = store.stage("owner/item", 1, owner, () => undefined);
    const handles = [task, deferred, interruption, subscription, contribution];
    owner.publish();
    const signal = await entered.promise;
    const before = owner.snapshot();

    try {
      for (const target of [owner, other])
        for (const handle of handles) await rejectAdoption(target, method, handle);

      expect(owner.snapshot()).toEqual(before);
      expect(other.snapshot()).toMatchObject({ cleanups: 0, acquisitions: 0 });
      expect(signal.aborted).toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
      await hub.emit("owned/notice", undefined);
      expect(listener).toHaveBeenCalledOnce();
      contribution.update(2);
      expect((await store.use("owner/item", (value) => value)).value).toBe(2);

      const taskCompletion = task[Symbol.asyncDispose]();
      expect(task[Symbol.asyncDispose]()).toBe(taskCompletion);
      expect(signal.aborted).toBe(true);
      finish.resolve();
      await taskCompletion;
      const cleanupCompletion = deferred[Symbol.asyncDispose]();
      expect(deferred[Symbol.asyncDispose]()).toBe(cleanupCompletion);
      await cleanupCompletion;
      interruption[Symbol.dispose]();
      subscription[Symbol.dispose]();
      contribution[Symbol.dispose]();

      expect(cleanup).toHaveBeenCalledOnce();
      expect(interrupt).not.toHaveBeenCalled();
      await hub.emit("owned/notice", undefined);
      expect(listener).toHaveBeenCalledOnce();
      expect(owner.snapshot()).toMatchObject({
        cleanups: 0,
        interrupts: 0,
        tasks: 0,
        acquisitions: 0,
        publications: 0,
      });
      for (const target of [owner, other])
        for (const handle of handles) await rejectAdoption(target, method, handle);
      expect(other.snapshot()).toMatchObject({ cleanups: 0, acquisitions: 0 });
    } finally {
      finish.resolve();
      await Promise.all([owner.dispose(), other.dispose()]);
    }
  },
);

it("keeps one failed cleanup obligation after refusing its control handle", async () => {
  const owner = new Lifetime({ resourceAuthority, label: "owner", report() {} });
  const other = new Lifetime({ resourceAuthority, label: "other", report() {} });
  const failure = new Error("one release failure");
  const release = vi.fn<() => void>(() => {
    throw failure;
  });
  const handle = owner.defer(release);
  try {
    expect(() => owner.use(handle)).toThrow(TypeError);
    expect(() => other.use(handle)).toThrow(TypeError);
    const completion = handle[Symbol.asyncDispose]();
    expect(handle[Symbol.asyncDispose]()).toBe(completion);
    await expect(completion).rejects.toBe(failure);
    await expect(handle[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({
      cleanups: 1,
      unresolved: [{ kind: "cleanup", error: { message: failure.message } }],
    });
    expect(other.snapshot()).toMatchObject({ cleanups: 0, unresolved: [] });
  } finally {
    await expect(owner.dispose()).rejects.toThrow("unresolved cleanup obligations");
    await other.dispose();
  }
});

it("retains the first ownership and terminal detachment of contribution view subscriptions", async () => {
  const owner = new Lifetime({ resourceAuthority, label: "owner", report() {} });
  const other = new Lifetime({ resourceAuthority, label: "other", report() {} });
  const registry = new ContributionRegistry(() => undefined);
  const point = extensionPoint<number>("owned/subscriptions");
  const contribution = registry.store<number>(point).stage("owner/item", 1, owner, () => undefined);
  const view = registry.view<number>(point, owner);
  owner.publish();
  const before = owner.snapshot();
  const listener = vi.fn<() => void>();
  const subscription = view.subscribe(listener);
  try {
    expect(owner.snapshot().cleanups).toBe(before.cleanups + 1);
    expect(() => other.use(subscription)).toThrow(TypeError);
    contribution.update(2);
    expect(listener).toHaveBeenCalledOnce();
    subscription[Symbol.dispose]();
    expect(owner.snapshot()).toEqual(before);
    expect(() => other.use(subscription)).toThrow(TypeError);
    contribution.update(3);
    expect(listener).toHaveBeenCalledOnce();
    expect(other.snapshot().cleanups).toBe(0);
  } finally {
    await Promise.all([owner.dispose(), other.dispose()]);
  }
});
