import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { createHost, definePlugin, event, extensionPoint, type PluginContext } from "../src/index";
import { onAbort } from "../src/advanced";
import { SnapshotPublisher } from "../src/observation/snapshot-view";
import { Lifetime } from "../src/lifetime/lifetime";

it("does not grant Event listeners the hub, root Lifetime, or detach authority as their receiver", async () => {
  const notice = event<void>("authority/notice");
  let retainedContext!: PluginContext<{}>;
  let receiver: unknown = null;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            retainedContext = context;
            context.events.on(notice, function (this: unknown) {
              receiver = this;
            });
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    await retainedContext.events.emit(notice);
    expect(receiver).toBeUndefined();
  } finally {
    await host.stop();
  }
});

it("does not expose a mutable subscription binding to snapshot observers or their reporter", () => {
  const receivers: unknown[] = [];
  const failure = new Error("observer failure");
  const publisher = new SnapshotPublisher(
    () => 1,
    function (this: unknown, error) {
      expect(error).toBe(failure);
      receivers.push(this);
    },
  );
  using _subscription = publisher.view.subscribe(function (this: unknown) {
    receivers.push(this);
    throw failure;
  });
  publisher.invalidate();
  expect(receivers).toEqual([undefined, undefined]);
});

it.each(["borrow", "task"] as const)(
  "settles a %s from one result without adopting its delivered value again",
  async (kind) => {
    const owner = new Lifetime({ label: "owner", report() {} });
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    // oxlint-disable-next-line unicorn/no-thenable -- distinguish single adoption from forwarding the resolved value
    const value = Object.defineProperty({}, "then", {
      get() {
        if (++reads === 1) return undefined;
        return (resolve: (result: number) => void) => {
          void gate.promise.then(() => resolve(2));
        };
      },
    });
    const result = kind === "task" ? owner.spawn(() => value).result : owner.borrow(() => value);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(1);
      expect(await result.then((actual) => actual === value)).toBe(true);
      expect(owner.snapshot()).toMatchObject({ foreground: 0, tasks: 0 });
    } finally {
      gate.resolve();
      await owner.dispose();
    }
  },
);

it.each(["borrow", "task"] as const)(
  "accounts for a rejected %s even if a foreign Promise constructor throws",
  async (kind) => {
    const failure = new Error("constructor access");
    const report = vi.fn<(error: unknown) => void>();
    const owner = new Lifetime({ label: "owner", report });
    const hostile = Object.defineProperty(Promise.resolve(1), "constructor", {
      get() {
        throw failure;
      },
    });
    const result =
      kind === "task" ? owner.spawn(() => hostile).result : owner.borrow(() => hostile);
    const caught: unknown[] = [];
    void result.catch((error: unknown) => {
      caught.push(error);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(caught).toEqual([failure]);
    expect(report).toHaveBeenCalledTimes(kind === "task" ? 1 : 0);
    expect(owner.snapshot()).toMatchObject({ foreground: 0, tasks: 0 });
    await owner.dispose();
  },
);

it("publishes executable contribution values at the same boundary as their collection", async () => {
  const point = extensionPoint<() => number>("authority/actions");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let retainedContext!: PluginContext<{}>;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            retainedContext = context;
          },
        }),
      },
    ],
  });
  await host.start();
  const first = () => 1;
  const next = () => 2;
  const view = host.contributions(point);
  const change = host.change();
  change.install(
    definePlugin({
      name: "slow",
      async setup() {
        entered.resolve();
        await gate.promise;
      },
    }),
    { id: "slow" },
  );
  const existing = retainedContext.contributions.add(point, "existing", first);
  retainedContext.contributions.add(point, "stable", first);
  const updating = host.apply(await host.plan(change));
  await entered.promise;
  try {
    existing.update(next);
    retainedContext.contributions.add(point, "new", next);
    expect(view.get()).toEqual(["owner/existing", "owner/stable"]);
    const unavailable = { code: "CONTRIBUTION_UNAVAILABLE" };
    for (const id of ["owner/existing", "owner/new"])
      await expect(view.use(id, (action) => action())).rejects.toMatchObject(unavailable);
    expect(await view.use("owner/stable", (action) => action())).toBe(1);
  } finally {
    gate.resolve();
    await updating;
    try {
      expect(view.get()).toEqual(["owner/existing", "owner/stable", "owner/new"]);
      expect(await view.use("owner/existing", (action) => action())).toBe(2);
      expect(await view.use("owner/new", (action) => action())).toBe(2);
    } finally {
      await host.stop();
    }
  }
});

it("binds a detached public contribution updater to its original entry", async () => {
  const point = extensionPoint<number>("authority/detached");
  let update!: (value: number) => void;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ contributions }) {
            ({ update } = contributions.add(point, "one", 1));
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    update(2);
    expect(await host.contributions(point).use("owner/one", (value) => value)).toBe(2);
  } finally {
    await host.stop();
  }
  expect(() => update(3)).toThrow("disposed");
});

it("isolates listener ownership across retired Lifetime signals", async () => {
  const lifetime = new Lifetime({ label: "root", report() {} });
  const firstChild = lifetime.child("a");
  const secondChild = lifetime.child("b");
  await lifetime.dispose();
  const listener = vi.fn<() => void>();
  const retired = firstChild.signal;
  retired.addEventListener("abort", listener);
  try {
    expect(retired.aborted).toBe(true);
    expect(firstChild.signal).toBe(retired);
    expect(secondChild.signal).not.toBe(retired);
    secondChild.signal.dispatchEvent(new Event("abort"));
    expect(listener).not.toHaveBeenCalled();
  } finally {
    retired.removeEventListener("abort", listener);
  }
});

it("propagates only an actual parent cancellation to child scopes and tasks", async () => {
  const parent = new AbortController();
  const owner = new Lifetime({ label: "root", report() {}, parentSignal: parent.signal });
  const child = owner.child("child");
  const ready = Promise.withResolvers<AbortSignal>();
  const gate = Promise.withResolvers<void>();
  const task = owner.spawn((signal) => {
    ready.resolve(signal);
    return gate.promise;
  });
  const taskSignal = await ready.promise;
  const reason = new Error("cancelled by controller");
  try {
    parent.signal.dispatchEvent(new Event("abort"));
    owner.signal.dispatchEvent(new Event("abort"));
    expect([owner.signal.aborted, child.signal.aborted, taskSignal.aborted]).toEqual([
      false,
      false,
      false,
    ]);
    parent.abort(reason);
    expect([owner.signal.reason, child.signal.reason, taskSignal.reason]).toEqual([
      reason,
      reason,
      reason,
    ]);
  } finally {
    gate.resolve();
    await task.result;
    await owner.dispose();
  }
});

it("uses native cancellation state, preserves the exact reason, and detaches explicitly", () => {
  const controller = new AbortController();
  const { signal } = controller;
  signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const fake = vi.fn<() => never>(() => {
    throw new Error("untrusted signal method");
  });
  Object.defineProperties(signal, {
    addEventListener: { value: fake },
    removeEventListener: { value: fake },
    throwIfAborted: { value: fake },
    reason: { value: "forged reason" },
    aborted: { value: true },
  });
  const removed = vi.fn<(reason: unknown) => void>();
  const notified = vi.fn<(reason: unknown) => void>();
  const detach = onAbort(signal, removed);
  onAbort(signal, notified);
  signal.dispatchEvent(new Event("abort"));
  detach();
  const reason = new TypeError("real controller reason");
  controller.abort(reason);
  signal.dispatchEvent(new Event("abort"));
  const late = vi.fn<(reason: unknown) => void>();
  onAbort(signal, late)();
  expect(removed).not.toHaveBeenCalled();
  expect(notified).toHaveBeenCalledExactlyOnceWith(reason);
  expect(late).toHaveBeenCalledExactlyOnceWith(reason);
  expect(fake).not.toHaveBeenCalled();
  expect(() => onAbort(new EventTarget() as AbortSignal, notified)).toThrow(TypeError);
  expect(() => onAbort(signal, null as never)).toThrow(TypeError);
});

it("observes an existing composite without consulting shadow state on its upstream signal", () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal]);
  const reason = new Error("cancelled upstream");
  Object.defineProperties(controller.signal, {
    aborted: { value: true },
    reason: { value: "wrong" },
  });
  signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const notified = vi.fn<(reason: unknown) => void>();
  const detach = onAbort(signal, notified);
  signal.dispatchEvent(new Event("abort"));
  signal.dispatchEvent(new Event("abort"));
  expect(notified).not.toHaveBeenCalled();
  controller.abort(reason);
  expect(notified).toHaveBeenCalledExactlyOnceWith(reason);
  detach();
});

it("leaves unrelated listeners intact even when a native registration hook throws", () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal]);
  const independent = vi.fn<() => void>();
  signal.addEventListener("abort", independent);
  const failure = new Error("unreadable instance property");
  Object.defineProperty(signal, "aborted", {
    get() {
      throw failure;
    },
  });
  const withdrawn = vi.fn<() => void>();
  try {
    onAbort(signal, withdrawn)();
  } catch (error) {
    if (error !== failure) throw error;
  }
  expect(getEventListeners(signal, "abort")).toEqual([independent]);
  controller.abort();
  expect(independent).toHaveBeenCalledOnce();
  expect(withdrawn).not.toHaveBeenCalled();
});

it("retains only ordered IDs in a snapshot when an executable contribution is replaced or removed", async () => {
  const token = extensionPoint<() => string>("authority/snapshot");
  let retainedContext!: PluginContext<{}>;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            retainedContext = context;
          },
        }),
      },
    ],
  });
  await host.start();
  const view = host.contributions(token);
  const run = () => "first";
  const entry = retainedContext.contributions.add(token, "run", run);
  const before = view.get();
  entry.update(run);
  expect(view.get()).toBe(before);
  entry.update(() => "second");
  const after = view.get();
  expect(Object.isFrozen(before)).toBe(true);
  expect(before).toEqual(["owner/run"]);
  expect(after).not.toBe(before);
  expect(after).toEqual(before);
  expect(await view.use(before[0]!, (invoke) => invoke())).toBe("second");
  await host.stop();
  expect(view.get()).toEqual([]);
  expect(before).toEqual(["owner/run"]);
  await expect(view.use(before[0]!, (invoke) => invoke())).rejects.toMatchObject({
    code: "CONTRIBUTION_UNAVAILABLE",
  });
});

it.each(["task", "acquisition"] as const)(
  "joins the real %s even when its public result is decorated by application code",
  async (kind) => {
    const owner = new Lifetime({ label: "owner", report() {} });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const cleanup = vi.fn<() => void>();
    owner.handle.defer(cleanup);
    const pending = async () => {
      entered.resolve();
      await gate.promise;
      return { [Symbol.dispose]() {} };
    };
    const result =
      kind === "task" ? owner.handle.spawn(pending).result : owner.handle.acquire(pending);
    const outcome = result.catch(() => undefined);
    await entered.promise;
    // oxlint-disable-next-line unicorn/no-thenable -- the caller must not control the owner’s internal join
    Object.defineProperty(result, "then", {
      value: (accept: () => void) => Promise.resolve().then(accept),
    });
    const closing = owner.dispose();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cleanup).not.toHaveBeenCalled();
      expect(owner.snapshot().phase).toBe("disposing");
    } finally {
      gate.resolve();
      await outcome;
      await closing;
    }
    expect(cleanup).toHaveBeenCalledOnce();
  },
);

it.each(["event", "contribution"] as const)(
  "does not reserve a contract kind when an invalid %s registration is rejected",
  async (kind) => {
    let retainedContext!: PluginContext<{}>;
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            setup(context) {
              retainedContext = context;
            },
          }),
        },
      ],
    });
    await host.start();
    const id = "authority/unclaimed";
    const notice = event<void>(id);
    const commands = extensionPoint<number>(id);
    try {
      const invalid =
        kind === "event"
          ? () => retainedContext.events.on(notice, null as never)
          : () => retainedContext.contributions.add(commands, "", 0);
      const valid =
        kind === "event"
          ? () => retainedContext.contributions.add(commands, "entry", 1)
          : () => retainedContext.events.on(notice, () => undefined);
      expect(invalid).toThrow(TypeError);
      expect(valid).not.toThrow();
    } finally {
      await host.stop();
    }
  },
);

it.each(["deferred cleanup", "child"] as const)(
  "keeps an early %s shutdown receipt from authorizing parent release",
  async (kind) => {
    const root = new Lifetime({ label: "owner", report() {} });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const releaseParent = vi.fn<() => void>();
    root.defer(releaseParent);
    const release = () => {
      entered.resolve();
      return gate.promise;
    };
    const child = root.child("child");
    const registered = (kind === "child" ? child : root.handle).defer(release);
    const shared = (kind === "child" ? child : registered)[Symbol.asyncDispose]();
    await entered.promise;
    Reflect.defineProperty(shared, "constructor", { value: Object });
    // oxlint-disable-next-line unicorn/no-thenable -- reproduce tampering with an early shutdown receipt
    Reflect.defineProperty(shared, "then", {
      value: (accept: () => void) => Promise.resolve().then(accept),
    });
    Reflect.defineProperty(shared, "catch", {
      value: () => {
        throw new Error("caller-supplied catch");
      },
    });
    const result = Promise.allSettled([root.dispose()]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releaseParent).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect(await result).toMatchObject([{ status: "fulfilled" }]);
    expect(releaseParent).toHaveBeenCalledOnce();
  },
);

it("rejects shutdown delays that native timers would overflow instead of expiring almost immediately", () => {
  const limit = 2 ** 31 - 1;
  expect(() => createHost({ shutdownTimeoutMilliseconds: limit + 1 })).toThrow(
    /shutdownTimeoutMilliseconds/,
  );
  expect(
    () => new Lifetime({ label: "invalid", report() {}, shutdownTimeoutMilliseconds: limit + 1 }),
  ).toThrow(/shutdownTimeoutMilliseconds/);
  expect(createHost({ shutdownTimeoutMilliseconds: limit }).status).toBe("stopped");
});
