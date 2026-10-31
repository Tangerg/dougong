import { expect, it, vi } from "vitest";
import { createHost, definePlugin, event, extensionPoint, type PluginContext } from "../src/index";
import { onAbort } from "../src/advanced";
import { SnapshotPublisher } from "../src/observation/snapshot-view";
import { Lifetime } from "../src/lifetime/lifetime";

it("does not grant Event listeners the hub, root Lifetime, or detach authority as their receiver", async () => {
  const notice = event<void>("authority/notice");
  let context!: PluginContext<{}>;
  let receiver: unknown = null;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(ctx) {
            context = ctx;
            ctx.events.on(notice, function (this: unknown) {
              receiver = this;
            });
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    await context.events.emit(notice);
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
  let context!: PluginContext<{}>;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(ctx) {
            context = ctx;
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
  const existing = context.contributions.add(point, "existing", first);
  context.contributions.add(point, "stable", first);
  const updating = host.apply(await host.plan(change));
  await entered.promise;
  try {
    existing.update(next);
    context.contributions.add(point, "new", next);
    expect(view.get().get("owner/existing")).toBe(first);
    expect(view.get().has("owner/new")).toBe(false);
    const unavailable = { code: "CONTRIBUTION_UNAVAILABLE" };
    for (const id of ["owner/existing", "owner/new"])
      await expect(async () => view.use(id, (action) => action())).rejects.toMatchObject(
        unavailable,
      );
    expect(await view.use("owner/stable", (action) => action())).toBe(1);
  } finally {
    gate.resolve();
    await updating;
    try {
      expect(view.get().get("owner/existing")).toBe(next);
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
    expect(host.contributions(point).get().get("owner/one")).toBe(2);
  } finally {
    await host.stop();
  }
  expect(() => update(3)).toThrow("disposed");
});

it("isolates listener ownership across retired Lifetime signals", async () => {
  const lifetime = new Lifetime({ label: "root", report() {} });
  const a = lifetime.child("a");
  const b = lifetime.child("b");
  await lifetime.dispose();
  const listener = vi.fn<() => void>();
  const retired = a.signal;
  retired.addEventListener("abort", listener);
  try {
    expect(retired.aborted).toBe(true);
    expect(a.signal).toBe(retired);
    expect(b.signal).not.toBe(retired);
    b.signal.dispatchEvent(new Event("abort"));
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
