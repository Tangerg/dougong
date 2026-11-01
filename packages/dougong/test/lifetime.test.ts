import { describe, expect, it, vi } from "vitest";
import { event, extensionPoint } from "../src/contracts/contracts";
import { isCancellationReason } from "../src/contracts/errors";
import type { AsyncDisposable, Disposable } from "../src/contracts/resource";
import { Lifetime, type Task } from "../src/lifetime/lifetime";
import { EventHub } from "../src/events/event-hub";
import { ContributionRegistry } from "../src/contributions/contribution-store";
import { createHost } from "../src/execution/host";
import { definePlugin } from "../src/composition/plugin";

const lifetime = (report: (error: unknown) => void = () => undefined) =>
  new Lifetime({ label: "test", report });

describe("structured lifetime", () => {
  it("classifies only canonical cancellation reasons after the signal aborts", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    expect(() => isCancellationReason(null as never, reason)).toThrow(
      "Cancellation classifier expects an AbortSignal",
    );
    expect(() => isCancellationReason({ aborted: false } as never, reason)).toThrow(
      "Cancellation classifier expects an AbortSignal",
    );
    expect(isCancellationReason(controller.signal, reason)).toBe(false);
    controller.abort(reason);
    expect(isCancellationReason(controller.signal, reason)).toBe(true);
    expect(isCancellationReason(controller.signal, new DOMException("late", "AbortError"))).toBe(
      true,
    );
    expect(isCancellationReason(controller.signal, new Error("late failure"))).toBe(false);
  });

  it("uses actual cancellation to close every scoped operation and reclaim late acquisitions", async () => {
    const controller = new AbortController();
    const owner = new Lifetime({ label: "owner", parentSignal: controller.signal, report() {} });
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const release = vi.fn<() => void>();
    const acquired = owner.handle.acquire(async () => {
      ready.resolve();
      await finish.promise;
      return { [Symbol.dispose]: release };
    });
    const events = new EventHub().scope(owner, () => undefined);
    const contributions = new ContributionRegistry(() => undefined).scope(
      owner,
      "owner",
      () => undefined,
    );
    const token = extensionPoint<number>("items");
    const contribution = contributions.add(token, "a", 1);
    await ready.promise;
    Object.defineProperties(owner.signal, {
      aborted: { value: false },
      reason: { value: "forged" },
    });
    controller.abort(null);
    try {
      expect(() => owner.handle.defer(() => undefined)).toThrow("closed");
      expect(() => events.on(event("test"), () => undefined)).toThrow("closed");
      expect(() => contributions.add(token, "b", 2)).toThrow("closed");
      expect(() => contribution.update(2)).toThrow("closed");
    } finally {
      finish.resolve();
      const outcome = await Promise.allSettled([acquired]);
      await owner.dispose();
      expect(outcome).toEqual([{ status: "rejected", reason: null }]);
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("detaches settled tasks while aborting and awaiting live tasks", async () => {
    const owner = lifetime();
    let completedSignal!: AbortSignal;
    let liveSignal!: AbortSignal;
    let settled = false;
    const started = Promise.withResolvers<void>();
    const completed = owner.spawn((signal) => {
      completedSignal = signal;
    });
    owner.spawn((signal) => {
      liveSignal = signal;
      started.resolve();
      return new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            settled = true;
            resolve();
          },
          { once: true },
        ),
      );
    });
    await Promise.all([completed.result, started.promise]);
    await completed[Symbol.asyncDispose]();
    expect(owner.snapshot().tasks).toBe(1);
    await owner.dispose();
    expect(completedSignal.aborted).toBe(false);
    expect(liveSignal.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("keeps Task disposal pending until non-cancellable work settles", async () => {
    const owner = lifetime();
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const task = owner.spawn(() => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    let settled = false;
    const disposing = Promise.resolve(task[Symbol.asyncDispose]()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    await disposing;
    expect(settled).toBe(true);
    await owner.dispose();
  });

  it("publishes task completion before cancellation can reenter disposal", async () => {
    const owner = lifetime();
    const started = Promise.withResolvers<void>();
    let task!: Task;
    let reentrant: unknown;
    task = owner.spawn(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              reentrant = task[Symbol.asyncDispose]();
              resolve();
            },
            { once: true },
          );
          started.resolve();
        }),
    );
    await started.promise;
    const completion = task[Symbol.asyncDispose]();
    await completion;
    expect(reentrant).toBe(completion);
    await owner.dispose();
  });

  it("reports failures after cancellation unless rejection is the cancellation outcome", async () => {
    const failure = new Error("shutdown flush failed");
    const report = vi.fn<(error: unknown) => void>();
    const owner = lifetime(report);
    const started = Promise.withResolvers<void>();
    let count = 0;
    const run = (reason: (signal: AbortSignal) => unknown) =>
      owner.spawn(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(reason(signal)), { once: true });
            if (++count === 2) started.resolve();
          }),
      );
    const failed = run(() => failure);
    const cancelled = run((signal) => signal.reason);
    await started.promise;
    await Promise.all([failed[Symbol.asyncDispose](), cancelled[Symbol.asyncDispose]()]);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await owner.dispose();
  });

  it("runs cleanup in LIFO order and attempts every item despite failure", async () => {
    const owner = lifetime();
    const trace: string[] = [];
    owner.defer(() => {
      trace.push("first");
      throw new Error("first failed");
    });
    owner.defer(async () => {
      trace.push("second");
      throw new Error("second failed");
    });
    owner.defer(() => {
      trace.push("third");
    });
    await expect(owner.dispose()).rejects.toMatchObject({ errors: expect.any(Array) });
    expect(trace).toEqual(["third", "second", "first"]);
    expect(owner.snapshot().unresolved).toHaveLength(2);
    expect(owner.phase).toBe("quarantined");
  });

  it("awaits early cleanup still in flight during parent disposal", async () => {
    const owner = lifetime();
    const entered = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    const cleanup = owner.defer(async () => {
      entered.resolve();
      await barrier.promise;
    });
    const early = cleanup[Symbol.asyncDispose]();
    await entered.promise;
    let stopped = false;
    const stopping = owner.dispose().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    barrier.resolve();
    await Promise.all([early, stopping]);
    expect(stopped).toBe(true);
  });

  it("publishes cleanup completion before reentrant disposal", async () => {
    const owner = lifetime();
    let cleanup!: AsyncDisposable;
    let reentrant: unknown;
    const release = vi.fn<() => void>(() => {
      reentrant = cleanup[Symbol.asyncDispose]();
    });
    cleanup = owner.defer(release);
    const completion = cleanup[Symbol.asyncDispose]();
    await completion;
    expect(reentrant).toBe(completion);
    expect(release).toHaveBeenCalledOnce();
    await owner.dispose();
  });

  it("does not replay early failed cleanup and keeps its unresolved obligation", async () => {
    const owner = lifetime();
    const failure = new Error("early cleanup failed");
    const release = vi.fn<() => void>(() => {
      throw failure;
    });
    const cleanup = owner.defer(release);
    await expect(cleanup[Symbol.asyncDispose]()).rejects.toBe(failure);
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(release).toHaveBeenCalledOnce();
    expect(owner.snapshot().unresolved[0]?.error.message).toBe(failure.message);
  });

  it("projects nested resource ownership into immutable values", async () => {
    const owner = lifetime();
    expect(() => owner.child("")).toThrow("non-empty");
    expect(() => owner.child(" padded ")).toThrow("trimmed");
    owner.defer(() => undefined);
    const session = owner.child("session");
    session.defer(() => undefined);
    const connection = session.child("connection");
    connection.defer(() => undefined);
    const snapshot = owner.snapshot();
    expect(snapshot.children[0]?.children[0]).toMatchObject({ label: "connection", cleanups: 1 });
    expect(Object.isFrozen(snapshot.children[0]?.children)).toBe(true);
    await connection[Symbol.asyncDispose]();
    expect(owner.snapshot().children[0]?.children).toEqual([]);
    await session[Symbol.asyncDispose]();
    expect(owner.snapshot().children).toEqual([]);
    expect(snapshot.children[0]?.children).toHaveLength(1);
    await owner.dispose();
  });

  it("keeps labels descriptive rather than treating them as unique identities", async () => {
    const owner = lifetime();
    owner.child("worker");
    owner.child("worker");
    expect(owner.snapshot().children.map((child) => child.label)).toEqual(["worker", "worker"]);
    await owner.dispose();
  });

  it("does not publish listeners or contributions from failed setup", async () => {
    const items = extensionPoint<string>("staged/items");
    const notice = event<string>("staged/notice");
    const listener = vi.fn<() => void>();
    const notified = vi.fn<() => void>();
    let emit!: (value: string) => Promise<void>;
    const host = createHost({
      installations: [
        {
          id: "emitter",
          plugin: definePlugin({
            name: "emitter",
            setup({ events }) {
              emit = (value) => events.emit(notice, value);
            },
          }),
        },
      ],
    });
    await host.start();
    const view = host.contributions(items);
    view.subscribe(notified);
    const change = host.change();
    change.install(
      definePlugin({
        name: "broken",
        setup({ events, contributions }) {
          events.on(notice, listener);
          contributions.add(items, "broken", "visible");
          throw new Error("setup failed");
        },
      }),
      { id: "broken" },
    );
    await expect(host.apply(await host.plan(change))).rejects.toMatchObject({
      details: { outcome: "restored" },
      cause: { message: "setup failed" },
    });
    expect(host.status).toBe("running");
    expect(view.get().length).toBe(0);
    expect(notified).not.toHaveBeenCalled();
    await emit("after");
    expect(listener).not.toHaveBeenCalled();
    await host.stop();
  });

  it("uses standard Disposable for early event and contribution release", async () => {
    const owner = lifetime();
    const hub = new EventHub();
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<string>("disposable");
    const listener = vi.fn<() => void>();
    const subscription = hub.stage("notice", listener, owner);
    const contribution = registry.get<string>(token).stage("owner", "item", "first", owner);
    owner.publish();
    {
      using owned = subscription;
      expect(owned).toBe(subscription);
      await hub.emit("notice", undefined);
    }
    await hub.emit("notice", undefined);
    expect(listener).toHaveBeenCalledOnce();
    {
      using owned = contribution;
      expect(owned).toBe(contribution);
    }
    expect(() => contribution.update("late")).toThrow("disposed");
    contribution[Symbol.dispose]();
    await owner.dispose();
  });

  it("supports await using for asynchronous child ownership", async () => {
    const owner = lifetime();
    const session = owner.child("session");
    const trace: string[] = [];
    session.defer(async () => {
      await Promise.resolve();
      trace.push("closed");
    });
    {
      await using owned = session;
      trace.push("open");
      expect(owned.signal.aborted).toBe(false);
    }
    trace.push("after");
    expect(trace).toEqual(["open", "closed", "after"]);
    await owner.dispose();
    expect(trace).toEqual(["open", "closed", "after"]);
  });

  it("owns child event listeners independently of the parent", async () => {
    const owner = lifetime();
    const child = owner.child("child");
    const notice = event<string>("child-notice");
    const hub = new EventHub();
    const events = hub.scope(owner, () => undefined);
    const rootListener = vi.fn<() => void>();
    const childListener = vi.fn<() => void>();
    events.on(notice, rootListener);
    events.on(notice, childListener, { lifetime: child });
    owner.publish();
    await events.emit(notice, "before");
    await child[Symbol.asyncDispose]();
    await events.emit(notice, "after");
    expect(rootListener.mock.calls).toEqual([["before"], ["after"]]);
    expect(childListener.mock.calls).toEqual([["before"]]);
    await owner.dispose();
  });

  it("prevents an obsolete contribution from deleting its replacement", async () => {
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<string>("replacement");
    const view = registry.view<string>(token);
    const first = lifetime();
    const old = registry.get<string>(token).stage("owner", "item", "old", first);
    first.publish();
    await first.dispose();
    const second = lifetime();
    const current = registry.get<string>(token).stage("owner", "item", "new", second);
    second.publish();
    old[Symbol.dispose]();
    expect(await Promise.all(view.get().map((id) => view.use(id, (value) => value)))).toEqual([
      "new",
    ]);
    current[Symbol.dispose]();
    expect(view.get().length).toBe(0);
    await second.dispose();
  });

  it("closes contribution views with their owning lifetime", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const view = registry.view(extensionPoint("view"), owner);
    expect(view.get().length).toBe(0);
    await owner.dispose();
    const closed = expect.objectContaining({ code: "LIFETIME_DISPOSED" });
    expect(() => view.get()).toThrowError(closed);
    expect(() => view.subscribe(() => undefined)).toThrowError(closed);
    await expect(view.use("owner/item", (value) => value)).rejects.toMatchObject({
      code: "LIFETIME_DISPOSED",
    });
  });

  it("withdraws an early disposed contribution subscription from the store", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<string>("subscription");
    const view = registry.view<string>(token, owner);
    const notified = vi.fn<() => void>();
    const subscription: Disposable = view.subscribe(notified);
    subscription[Symbol.dispose]();
    registry.get<string>(token).stage("owner", "item", "value", owner);
    owner.publish();
    expect(await Promise.all(view.get().map((id) => view.use(id, (value) => value)))).toEqual([
      "value",
    ]);
    expect(notified).not.toHaveBeenCalled();
    await owner.dispose();
  });

  it("settles apply only after contribution publication and coalesces a complete batch", async () => {
    const items = extensionPoint<string>("batch");
    const host = createHost();
    await host.start();
    const view = host.contributions(items);
    const sizes: number[] = [];
    view.subscribe(() => {
      sizes.push(view.get().length);
    });
    const change = host.change();
    const group = change.group("batch");
    for (const id of ["first", "second"])
      change.install(
        definePlugin({
          name: id,
          setup({ contributions }) {
            contributions.add(items, "shared", id);
          },
        }),
        { id, group },
      );
    await host.apply(await host.plan(change));
    expect(await Promise.all(view.get().map((id) => view.use(id, (value) => value)))).toEqual([
      "first",
      "second",
    ]);
    expect(sizes).toEqual([2]);
    await host.stop();
  });

  it("qualifies contribution keys without collisions", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<number>("keys");
    const store = registry.get<number>(token);
    store.stage("owner:1", "nested:2/item", 1, owner);
    store.stage("owner:1/nested:2", "item", 2, owner);
    owner.publish();
    expect([...store.snapshot()]).toEqual(["owner:1/nested:2%2Fitem", "owner:1%2Fnested:2/item"]);
    await owner.dispose();
  });

  it("preserves undefined as a live contribution value", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const store = registry.get<number | undefined>(extensionPoint("undefined"));
    const contribution = store.stage("owner", "item", undefined, owner);
    owner.publish();
    expect(
      await Promise.all(store.snapshot().map((id) => store.use(id, (value) => value))),
    ).toEqual([undefined]);
    contribution.update(1);
    expect(
      await Promise.all(store.snapshot().map((id) => store.use(id, (value) => value))),
    ).toEqual([1]);
    contribution.update(undefined);
    expect(
      await Promise.all(store.snapshot().map((id) => store.use(id, (value) => value))),
    ).toEqual([undefined]);
    await owner.dispose();
  });

  it("publishes a scope tree with a child still finishing cleanup", async () => {
    const owner = lifetime();
    const child = owner.child("child");
    const grandchild = child.child("grandchild");
    const draining = Promise.withResolvers<void>();
    grandchild.defer(() => draining.promise);
    const closing = grandchild[Symbol.asyncDispose]();
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<string>("disposing-child");
    registry
      .scope(owner, "owner", () => undefined)
      .add(token, "kept", "value", { lifetime: child });
    owner.publish();
    expect(await registry.view<string>(token).use("owner/kept", (value) => [value])).toEqual([
      "value",
    ]);
    draining.resolve();
    await closing;
    await owner.dispose();
  });

  it("publishes declarations from a child created after the root commit", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const point = extensionPoint<string>("late");
    const contributions = registry.scope(owner, "owner", () => undefined);
    const view = registry.view<string>(point);
    owner.publish();
    const child = owner.child("outer").child("inner");
    contributions.add(point, "key", "value", { lifetime: child });
    expect(await Promise.all(view.get().map((id) => view.use(id, (value) => value)))).toEqual([
      "value",
    ]);
    await owner.dispose();
  });

  it("publishes a whole staged scope tree as one committed snapshot", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const token = extensionPoint<string>("staged-tree");
    const contributions = registry.scope(owner, "owner", () => undefined);
    const view = registry.view<string>(token);
    const sizes: number[] = [];
    view.subscribe(() => {
      sizes.push(view.get().length);
    });
    contributions.add(token, "root", "1");
    contributions.add(token, "child", "2", { lifetime: owner.child("child") });
    contributions.add(token, "nested", "3", { lifetime: owner.child("outer").child("nested") });
    registry.beginBatch();
    owner.publish();
    expect(view.get().length).toBe(0);
    registry.endBatch();
    expect(view.get().length).toBe(3);
    expect(sizes).toEqual([3]);
    await owner.dispose();
  });
});
