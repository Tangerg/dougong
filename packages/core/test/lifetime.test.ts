import { describe, expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type Contribution,
  type LifetimeContext,
  type Task,
} from "../src/index";

describe("structured lifetime", () => {
  it("detaches settled tasks while still aborting and awaiting live tasks", async () => {
    let completed!: Task;
    let completedSignal!: AbortSignal;
    let liveSignal!: AbortSignal;
    let liveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      liveStarted = resolve;
    });
    let liveSettled = false;
    const plugin = definePlugin({
      name: "lifetime.tasks",
      setup(ctx) {
        completed = ctx.spawn((signal) => {
          completedSignal = signal;
        });
        ctx.spawn((signal) => {
          liveSignal = signal;
          liveStarted();
          return new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                liveSettled = true;
                resolve();
              },
              { once: true },
            );
          });
        });
      },
    });

    const host = createHost();
    host.install(plugin);
    await host.start();
    await Promise.all([completed.result, started]);
    await completed.dispose();
    expect(completedSignal.aborted).toBe(false);

    await host.stop();

    expect(completedSignal.aborted).toBe(false);
    expect(liveSignal.aborted).toBe(true);
    expect(liveSettled).toBe(true);
  });

  it("publishes the canonical completion before task cancellation can reenter disposal", async () => {
    let task!: Task;
    let taskStarted!: () => void;
    let reentrantCompletion: unknown;
    const started = new Promise<void>((resolve) => {
      taskStarted = resolve;
    });
    const plugin = definePlugin({
      name: "lifetime.reentrant-task",
      setup(ctx) {
        task = ctx.spawn(
          (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  reentrantCompletion = task.dispose();
                  resolve();
                },
                { once: true },
              );
              taskStarted();
            }),
        );
      },
    });
    const host = createHost();
    host.install(plugin);
    await host.start();
    await started;

    const completion = task.dispose();
    await completion;

    expect(reentrantCompletion).toBe(completion);
    await host.stop();
  });

  it("runs cleanup in LIFO order, attempts every item and aggregates failures", async () => {
    const trace: string[] = [];
    const plugin = definePlugin({
      name: "lifetime.cleanup",
      setup(ctx) {
        ctx.cleanup(() => {
          trace.push("first");
          throw new Error("first failed");
        });
        ctx.cleanup(async () => {
          trace.push("second");
          throw new Error("second failed");
        });
        ctx.cleanup(() => trace.push("third"));
      },
    });

    const host = createHost();
    host.install(plugin);
    await host.start();
    await expect(host.stop()).rejects.toMatchObject({ errors: expect.any(Array) });
    expect(trace).toEqual(["third", "second", "first"]);
  });

  it("awaits an early cleanup that is still in flight during parent disposal", async () => {
    let entered!: () => void;
    let release!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleanup!: { dispose(): void | Promise<void> };
    const plugin = definePlugin({
      name: "lifetime.in-flight-cleanup",
      setup(ctx) {
        cleanup = ctx.cleanup(async () => {
          entered();
          await barrier;
        });
      },
    });
    const host = createHost();
    host.install(plugin);
    await host.start();

    const early = cleanup.dispose();
    await cleaning;
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await Promise.all([early, stopping]);
    expect(stopped).toBe(true);
  });

  it("publishes the canonical completion before cleanup can reenter disposal", async () => {
    let cleanup!: { dispose(): void | Promise<void> };
    let reentrantCompletion: unknown;
    const disposeBody = vi.fn<() => void>(() => {
      reentrantCompletion = cleanup.dispose();
    });
    const plugin = definePlugin({
      name: "lifetime.reentrant-cleanup",
      setup(ctx) {
        cleanup = ctx.cleanup(disposeBody);
      },
    });
    const host = createHost();
    host.install(plugin);
    await host.start();

    const completion = cleanup.dispose();
    await completion;

    expect(reentrantCompletion).toBe(completion);
    expect(disposeBody).toHaveBeenCalledOnce();
    await host.stop();
  });

  it("does not replay a failed cleanup after its early disposal has settled", async () => {
    const failure = new Error("early cleanup failed");
    let cleanup!: { dispose(): void | Promise<void> };
    const plugin = definePlugin({
      name: "lifetime.failed-early-cleanup",
      setup(ctx) {
        cleanup = ctx.cleanup(() => {
          throw failure;
        });
      },
    });
    const host = createHost();
    host.install(plugin);
    await host.start();

    await expect(cleanup.dispose()).rejects.toBe(failure);
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("projects real nested ownership into immutable diagnostics", async () => {
    let session: LifetimeContext | undefined;
    let connection: LifetimeContext | undefined;
    const plugin = definePlugin({
      name: "lifetime.diagnostic-tree",
      setup(ctx) {
        expect(() => ctx.lifetime("")).toThrow("non-empty string");
        expect(() => ctx.lifetime(" padded ")).toThrow("whitespace");

        ctx.cleanup(() => undefined);
        session = ctx.lifetime("session");
        session.cleanup(() => undefined);
        connection = session.lifetime("connection");
        connection.cleanup(() => undefined);
      },
    });
    const host = createHost();
    const handle = host.install(plugin);
    await host.start();
    if (!session || !connection) throw new TypeError("Lifetime fixture did not initialize");

    const diagnostics = host.diagnostics.get().installations.get(handle.id)?.lifetime;
    if (!diagnostics) throw new TypeError("Lifetime diagnostics were not published");
    const snapshot = diagnostics.get();
    expect(snapshot).toEqual({
      label: handle.id,
      phase: "active",
      cleanups: 1,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      extensionViews: 0,
      subscriptions: 0,
      children: [
        {
          label: "session",
          phase: "active",
          cleanups: 1,
          tasks: 0,
          listeners: 0,
          contributions: 0,
          extensionViews: 0,
          subscriptions: 0,
          children: [
            {
              label: "connection",
              phase: "active",
              cleanups: 1,
              tasks: 0,
              listeners: 0,
              contributions: 0,
              extensionViews: 0,
              subscriptions: 0,
              children: [],
            },
          ],
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.children)).toBe(true);
    expect(Object.isFrozen(snapshot.children[0])).toBe(true);
    expect(Object.isFrozen(snapshot.children[0]?.children)).toBe(true);
    expect(Object.isFrozen(snapshot.children[0]?.children[0])).toBe(true);

    await connection.dispose();
    expect(diagnostics.get()).toMatchObject({
      cleanups: 1,
      children: [{ label: "session", cleanups: 1, children: [] }],
    });

    await session.dispose();
    expect(diagnostics.get()).toMatchObject({
      cleanups: 1,
      children: [],
    });

    await host.stop();
    expect(diagnostics.get()).toMatchObject({
      label: handle.id,
      phase: "disposed",
      cleanups: 0,
      children: [],
    });
  });

  it("keeps Lifetime labels descriptive rather than turning them into identities", async () => {
    const plugin = definePlugin({
      name: "lifetime.duplicate-labels",
      setup(ctx) {
        ctx.lifetime("worker");
        ctx.lifetime("worker");
      },
    });
    const host = createHost();
    const handle = host.install(plugin);
    await host.start();

    const snapshot = host.diagnostics.get().installations.get(handle.id)?.lifetime?.get();
    expect(snapshot?.children.map((child) => child.label)).toEqual(["worker", "worker"]);

    await host.stop();
  });

  it("does not publish listeners or contributions from a failed setup", async () => {
    const ITEMS = extensionPoint<string>("lifetime/staged-items");
    const NOTICE = event<string>("lifetime/staged-notice");
    const listener = vi.fn<(value: string) => void>();
    const notified = vi.fn<() => void>();
    let emit!: (value: string) => Promise<void>;
    let view!: { get(): ReadonlyMap<string, string>; subscribe(listener: () => void): unknown };
    const reader = definePlugin({
      name: "lifetime.reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
        ctx.items.subscribe(notified);
      },
    });
    const emitter = definePlugin({
      name: "lifetime.emitter",
      setup(ctx) {
        emit = (value) => ctx.emit(NOTICE, value);
      },
    });
    const broken = definePlugin({
      name: "lifetime.broken",
      setup(ctx) {
        ctx.on(NOTICE, listener);
        ctx.contribute(ITEMS, "broken", "visible");
        throw new Error("setup failed");
      },
    });

    const host = createHost();
    host.install(reader);
    host.install(emitter);
    await host.start();
    const failed = host.install(broken);
    await expect(failed.ready()).rejects.toThrow("setup failed");
    expect(host.status).toBe("active");
    expect(view.get().size).toBe(0);
    expect(notified).not.toHaveBeenCalled();
    await emit("after");
    expect(listener).not.toHaveBeenCalled();
    await host.stop();
  });

  it("uses one Disposable protocol for early resource release", async () => {
    const NOTICE = event<void>("lifetime/disposable-event");
    const ITEMS = extensionPoint<string>("lifetime/disposable-items");
    const listener = vi.fn<() => void>();
    let contribution!: Contribution<string>;
    const plugin = definePlugin({
      name: "lifetime.disposable",
      setup(ctx) {
        const subscription = ctx.on(NOTICE, listener);
        contribution = ctx.contribute(ITEMS, "item", "first");
        subscription.dispose();
        contribution.dispose();
      },
    });
    const emitter = definePlugin({
      name: "lifetime.disposable-emitter",
      async setup(ctx) {
        await ctx.emit(NOTICE, undefined);
      },
    });

    const host = createHost();
    host.install(plugin);
    host.install(emitter);
    await host.start();
    expect(listener).not.toHaveBeenCalled();
    expect(() => contribution.update("late")).toThrow("disposed");
    await expect(Promise.resolve(contribution.dispose())).resolves.toBeUndefined();
    await host.stop();
  });

  it("prevents an obsolete contribution handle from deleting its replacement", async () => {
    const ITEMS = extensionPoint<string>("lifetime/replacement-items");
    let old!: Contribution<string>;
    let current!: Contribution<string>;
    let view!: { get(): ReadonlyMap<string, string> };
    const reader = definePlugin({
      name: "lifetime.replacement-reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
      },
    });
    const writer = definePlugin({
      name: "lifetime.replacement-writer",
      setup(ctx, value: string) {
        const handle = ctx.contribute(ITEMS, "item", value);
        if (value === "old") old = handle;
        else current = handle;
      },
    });

    const host = createHost();
    host.install(reader);
    const handle = host.install(writer, "old");
    await host.start();
    await handle.update({ config: "new" });
    old.dispose();

    expect([...view.get().values()]).toEqual(["new"]);
    current.dispose();
    expect(view.get().size).toBe(0);
    await host.stop();
  });

  it("closes live ExtensionPoint views with the Lifetime that owns them", async () => {
    const ITEMS = extensionPoint<string>("lifetime/view-lease");
    let view!: {
      get(): ReadonlyMap<string, string>;
      subscribe(listener: () => void): unknown;
    };
    const reader = definePlugin({
      name: "lifetime.view-lease-reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
      },
    });
    const host = createHost();
    host.install(reader);
    await host.start();
    expect(view.get().size).toBe(0);

    await host.stop();

    expect(() => view.get()).toThrow("Contribution view has been disposed");
    expect(() => view.subscribe(() => undefined)).toThrow("Contribution view has been disposed");
  });

  it("withdraws an early-disposed ExtensionPoint subscription from its Store", async () => {
    const ITEMS = extensionPoint<string>("lifetime/extension-subscription");
    const notified = vi.fn<() => void>();
    let subscription!: { dispose(): void | Promise<void> };
    let view!: { get(): ReadonlyMap<string, string> };
    const reader = definePlugin({
      name: "lifetime.extension-subscriber",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
        subscription = ctx.items.subscribe(notified);
      },
    });
    const writer = definePlugin({
      name: "lifetime.extension-publisher",
      setup(ctx) {
        ctx.contribute(ITEMS, "item", "value");
      },
    });
    const host = createHost();
    host.install(reader);
    await host.start();

    await subscription.dispose();
    const changes = host.change();
    changes.install(writer);
    await changes.commit();

    expect([...view.get().values()]).toEqual(["value"]);
    expect(notified).not.toHaveBeenCalled();
    await host.stop();
  });

  it("settles active installation only after its ExtensionPoint batch is published", async () => {
    const ITEMS = extensionPoint<string>("lifetime/ready-after-extension-batch");
    let view!: { get(): ReadonlyMap<string, string> };
    const reader = definePlugin({
      name: "lifetime.ready-reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
      },
    });
    const writer = definePlugin({
      name: "lifetime.ready-writer",
      setup(ctx) {
        ctx.contribute(ITEMS, "item", "published");
      },
    });
    const host = createHost();
    host.install(reader);
    await host.start();

    const installed = host.install(writer);
    await installed.ready();

    expect([...view.get().values()]).toEqual(["published"]);
    await host.stop();
  });

  it("coalesces a multi-plugin commit into one ExtensionPoint notification", async () => {
    const ITEMS = extensionPoint<string>("lifetime/batched-items");
    const notified = vi.fn<() => void>();
    let view!: { get(): ReadonlyMap<string, string> };
    const reader = definePlugin({
      name: "lifetime.batch-reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
        ctx.items.subscribe(notified);
      },
    });
    const writer = (name: string) =>
      definePlugin({
        name: `lifetime.${name}`,
        setup(ctx) {
          ctx.contribute(ITEMS, "shared", name);
        },
      });

    const host = createHost();
    host.install(reader);
    await host.start();
    const group = host.group("batch", (plugins) => {
      plugins.install(writer("first"));
      plugins.install(writer("second"));
    });
    await group.ready();

    expect(notified).toHaveBeenCalledTimes(1);
    expect([...view.get().values()]).toEqual(["first", "second"]);
    expect([...view.get().keys()].every((key) => key.endsWith("/shared"))).toBe(true);
    await host.stop();
  });

  it("qualifies contribution keys without collisions between owners and local keys", async () => {
    const ITEMS = extensionPoint<number>("lifetime/collision-free-items");
    let view!: { get(): ReadonlyMap<string, number> };

    const first = definePlugin({
      name: "owner",
      setup(ctx) {
        ctx.contribute(ITEMS, "nested:2/item", 1);
      },
    });
    const second = definePlugin({
      name: "owner:1/nested",
      setup(ctx) {
        ctx.contribute(ITEMS, "item", 2);
      },
    });
    const reader = definePlugin({
      name: "reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
      },
    });

    const host = createHost();
    host.install(first);
    host.install(second);
    host.install(reader);
    await host.start();

    expect([...view.get().values()]).toEqual([1, 2]);
    expect([...view.get().keys()]).toEqual(["owner:1/nested:2%2Fitem", "owner:1%2Fnested:2/item"]);
    await host.stop();
  });

  it("preserves undefined as a live ExtensionPoint contribution value", async () => {
    const ITEMS = extensionPoint<number | undefined>("lifetime/undefined-items");
    let contribution: Contribution<number | undefined> | undefined;
    let view: { get(): ReadonlyMap<string, number | undefined> } | undefined;
    const writer = definePlugin({
      name: "undefined-writer",
      setup(ctx) {
        contribution = ctx.contribute(ITEMS, "item", undefined);
      },
    });
    const reader = definePlugin({
      name: "undefined-reader",
      requires: { items: ITEMS },
      setup(ctx) {
        view = ctx.items;
      },
    });

    const host = createHost();
    host.install(writer);
    host.install(reader);
    await host.start();
    if (!contribution || !view) throw new TypeError("ExtensionPoint fixture did not initialize");

    expect([...view.get().values()]).toEqual([undefined]);
    contribution.update(1);
    expect([...view.get().values()]).toEqual([1]);
    contribution.update(undefined);
    expect([...view.get().values()]).toEqual([undefined]);
    await host.stop();
  });
});
