import { expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type optional,
  service,
  type ChildLifetime,
  type Contribution,
} from "../src";
import { ContributionRegistry } from "../src/contributions/contribution-registry";
import { Lifetime } from "../src/lifetime/lifetime";

const resourceAuthority = createResourceAuthority();

it.each(["left", "right"])(
  "publishes the whole contribution batch before notifying %s",
  async (side) => {
    const left = extensionPoint<number>("boundary.commit-left");
    const right = extensionPoint<number>("boundary.commit-right");
    const declaration = (value: number) =>
      definePlugin({
        name: "boundary.commit",
        setup(context) {
          context.contributions.add(left, "value", value);
          context.contributions.add(right, "value", value * 2);
          if (value < 0) throw new Error("activation failed");
        },
      });
    const host = createHost({
      resourceAuthority,
      installations: [{ id: "owner", plugin: declaration(1) }],
    });
    const installation = host.installation("owner")!;
    const leftView = host.contributions(left);
    const rightView = host.contributions(right);
    const seen: number[][][] = [];
    const readings: Promise<unknown>[] = [];
    using _subscription = (side === "left" ? leftView : rightView).subscribe(() => {
      const pair: number[][] = [[], []];
      seen.push(pair);
      for (const [index, view] of [leftView, rightView].entries()) {
        for (const id of view.get())
          readings.push(
            view.use(id, (value) => {
              pair[index]!.push(value);
            }),
          );
      }
    });
    await host.start();
    const update = host.change();
    update.update(installation, { plugin: declaration(2) });
    await host.apply(await host.plan(update));
    const failure = host.change();
    failure.update(installation, { plugin: declaration(-1) });
    await expect(host.apply(await host.plan(failure))).rejects.toMatchObject({
      details: { outcome: "restored" },
      cause: { message: "activation failed" },
    });
    await host.stop();
    await Promise.all(readings);
    expect(seen).toEqual([
      [[1], [2]],
      [[2], [4]],
      [[2], [4]],
      [[], []],
    ]);
  },
);

it("publishes a changed contribution key even when both values are undefined", async () => {
  const registry = new ContributionRegistry(() => undefined);
  const store = registry.store(extensionPoint<undefined>("boundary.items"));
  const owner = new Lifetime({ resourceAuthority, label: "owner", report: () => undefined });
  const old = store.stage("owner/old", undefined, owner, () => undefined);
  owner.publish();
  const changed = vi.fn<() => void>();
  using _subscription = store.subscribe(changed, owner);
  registry.beginBatch();
  old[Symbol.dispose]();
  store.stage("owner/new", undefined, owner, () => undefined);
  registry.endBatch();
  expect(store.snapshot()).toEqual(["owner/new"]);
  expect((await store.use("owner/new", (value) => value)).value).toBeUndefined();
  expect(changed).toHaveBeenCalledOnce();
  await owner.dispose();
});

it("keeps an entered event callback borrowed until it settles before closing its child owner", async () => {
  const notice = event<void>("boundary.queued-event");
  const finish = Promise.withResolvers<void>();
  const listener = vi.fn<() => Promise<void>>(() => finish.promise);
  let child!: ChildLifetime;
  let emit!: () => Promise<void>;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "boundary.queued-event",
          setup(context) {
            child = context.lifetime.child("child");
            context.events.on(notice, listener, { lifetime: child });
            emit = () => context.events.emit(notice);
          },
        }),
      },
    ],
  });
  await host.start();
  const emission = emit();
  await expect(child[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
  expect(child.signal.aborted).toBe(false);
  finish.resolve();
  await emission;
  await child[Symbol.asyncDispose]();
  await emit();
  expect(listener).toHaveBeenCalledOnce();
  await host.stop();
});

it("closes incoming subscriptions before diagnostics can reenter shutdown", async () => {
  const items = extensionPoint<number>("boundary.diagnostic-items");
  const notice = event<void>("boundary.diagnostic-event");
  let item!: Contribution<number>;
  const listener = vi.fn<() => void>();
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "source",
        plugin: definePlugin({
          name: "boundary.source",
          setup(context) {
            item = context.contributions.add(items, "value", 0);
          },
        }),
      },
      {
        id: "reader",
        plugin: definePlugin({
          name: "boundary.reader",
          requires: { items },
          setup(context) {
            context.events.on(notice, () => undefined);
            context.dependencies.items.subscribe(listener);
          },
        }),
      },
    ],
  });
  const owner = host.installation("reader")!;
  await host.start();
  listener.mockClear();
  let value = 0;
  using subscription = host.diagnostics.subscribe(() => {
    if (owner.status === "changing") item.update(++value);
  });
  const change = host.change();
  change.remove(owner);
  await host.apply(await host.plan(change));
  expect(value).toBeGreaterThan(0);
  expect(listener).not.toHaveBeenCalled();
  subscription[Symbol.dispose]();
  await host.stop();
});

it("closes all descendant event entrances before cancellation and while tasks settle", async () => {
  const ping = event<void>("boundary.ping");
  const items = extensionPoint<number>("boundary.items");
  const blocked = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let parent!: ChildLifetime;
  let child!: ChildLifetime;
  let emit!: () => Promise<void>;
  const heard = vi.fn<() => void>();
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "boundary.owner",
          setup(context) {
            parent = context.lifetime.child("parent");
            child = parent.child("child").child("grandchild");
            context.events.on(ping, heard, { lifetime: child });
            context.contributions.add(items, "item", 1, { lifetime: child });
            parent.spawn((signal) => {
              signal.addEventListener(
                "abort",
                () => {
                  void emit();
                  aborted.resolve();
                },
                { once: true },
              );
              return blocked.promise;
            });
          },
        }),
      },
      {
        id: "emitter",
        plugin: definePlugin({
          name: "boundary.emitter",
          setup(context) {
            emit = () => context.events.emit(ping);
          },
        }),
      },
    ],
  });
  await host.start();
  const stopping = parent[Symbol.asyncDispose]();
  try {
    await emit();
    await aborted.promise;
    await emit();
    expect(heard).not.toHaveBeenCalled();
    expect(host.contributions(items).get().length).toBe(0);
    expect(() => child.defer(() => undefined)).toThrow("closed");
  } finally {
    blocked.resolve();
    await stopping;
    await host.stop();
  }
});

it("rejects the Promise protocol output alias at declaration time", () => {
  expect(() =>
    definePlugin({
      name: "boundary.then",
      // oxlint-disable-next-line unicorn/no-thenable -- regression input for the declaration boundary
      provides: { then: service<() => void>("app.then") },
      // oxlint-disable-next-line unicorn/no-thenable -- must be rejected before setup is called
      setup: () => ({ then() {} }),
    }),
  ).toThrow("then");
});

it("owns frozen Contract identities after normalizing structural declarations", async () => {
  const mutable = { id: "boundary.value", kind: "service" as const };
  const optionalToken = {
    kind: "optional" as const,
    service: { id: "boundary.optional", kind: "service" as const },
  };
  const provider = definePlugin({
    name: "boundary.provider",
    provides: { value: mutable as ReturnType<typeof service<number>> },
    setup: () => ({ value: 7 }),
  });
  let received: unknown;
  const consumer = definePlugin({
    name: "boundary.consumer",
    requires: {
      value: mutable as ReturnType<typeof service<number>>,
      maybe: optionalToken as ReturnType<typeof optional<number>>,
    },
    setup(context) {
      received = [context.dependencies.value, context.dependencies.maybe];
    },
  });
  mutable.id = "mutated";
  optionalToken.service.id = "also-mutated";
  const host = createHost({
    resourceAuthority,
    installations: [
      { id: "provider", plugin: provider },
      { id: "consumer", plugin: consumer },
    ],
  });
  await host.start();
  expect((await host.use(service<number>("boundary.value"), (value) => value)).value).toBe(7);
  expect(received).toEqual([7, undefined]);
  expect(consumer.requires?.maybe.service.id).toBe("boundary.optional");
  expect(Object.isFrozen(consumer.requires?.maybe.service)).toBe(true);
  expect(Object.isFrozen(mutable)).toBe(false);
  await host.stop();
});

it("allows a cancelling parent task to await its child's disposal", async () => {
  const owner = new Lifetime({ resourceAuthority, label: "owner", report: () => undefined });
  const parent = owner.handle.child("parent");
  const child = parent.child("child");
  const entered = Promise.withResolvers<void>();
  let childReleased = false;
  let parentCompleted = false;
  child.defer(() => {
    childReleased = true;
  });
  parent.spawn(async (signal) => {
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    entered.resolve();
    await aborted;
    await child[Symbol.asyncDispose]();
    parentCompleted = true;
  });
  await entered.promise;
  await parent[Symbol.asyncDispose]();
  expect(childReleased).toBe(true);
  expect(parentCompleted).toBe(true);
  await owner.dispose();
});

it("validates a contribution callback before looking up the contribution", async () => {
  const host = createHost({ resourceAuthority });
  const view = host.contributions(extensionPoint<number>("boundary.callback"));
  await expect(view.use("missing", 1 as never)).rejects.toThrowError(
    new TypeError("Contribution callback must be a function"),
  );
});
