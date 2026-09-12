import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type optional,
  service,
  type LifetimeContext,
  type Contribution,
} from "../src";
import { ContributionRegistry } from "../src/contribution-store";

it.each(["left", "right"])(
  "publishes the whole contribution batch before notifying %s",
  async (side) => {
    const host = createHost();
    const left = extensionPoint<number>("boundary.commit-left");
    const right = extensionPoint<number>("boundary.commit-right");
    const leftView = host.contributions(left);
    const rightView = host.contributions(right);
    const seen: number[][][] = [];
    using _subscription = (side === "left" ? leftView : rightView).subscribe(() => {
      seen.push([[...leftView.get().values()], [...rightView.get().values()]]);
    });
    const declaration = (value: number) =>
      definePlugin({
        name: "boundary.commit",
        setup(ctx) {
          ctx.contribute(left, "value", value);
          ctx.contribute(right, "value", value * 2);
          if (value < 0) throw new Error("activation failed");
        },
      });
    const installation = host.install(declaration(1));
    await host.start();
    await installation.update({ plugin: declaration(2) });
    await expect(installation.update({ plugin: declaration(-1) })).rejects.toThrow(
      "activation failed",
    );
    await host.stop();
    expect(seen).toEqual([
      [[1], [2]],
      [[2], [4]],
      [[], []],
    ]);
  },
);

it("publishes a changed contribution key even when both values are undefined", () => {
  const registry = new ContributionRegistry(() => undefined);
  const store = registry.get(extensionPoint<undefined>("boundary.items"));
  const old = store.stage("owner", "old", undefined, () => undefined);
  old.publish();
  const changed = vi.fn<() => void>();
  store.subscribe(changed, () => () => undefined);
  registry.beginBatch();
  old.dispose();
  store.stage("owner", "new", undefined, () => undefined).publish();
  registry.endBatch();
  expect([...store.snapshot()]).toEqual([["owner/new", undefined]]);
  expect(changed).toHaveBeenCalledOnce();
});

it("withdraws event callbacks already queued when their Lifetime closes", async () => {
  const host = createHost();
  const notice = event<void>("boundary.queued-event");
  const listener = vi.fn<() => void>();
  let child!: LifetimeContext;
  let emit!: () => Promise<void>;
  host.install(
    definePlugin({
      name: "boundary.queued-event",
      setup(ctx) {
        child = ctx.lifetime("child");
        child.on(notice, listener);
        emit = () => ctx.emit(notice);
      },
    }),
  );
  await host.start();
  const emission = emit();
  const disposal = child.dispose();
  await Promise.all([emission, disposal]);
  expect(listener).not.toHaveBeenCalled();
  await host.stop();
});

it("withdraws all incoming subscriptions before diagnostics can reenter shutdown", async () => {
  const host = createHost();
  const items = extensionPoint<number>("boundary.diagnostic-items");
  const notice = event<void>("boundary.diagnostic-event");
  let item!: Contribution<number>;
  const listener = vi.fn<() => void>();
  host.install(
    definePlugin({
      name: "boundary.source",
      setup(ctx) {
        item = ctx.contribute(items, "value", 0);
      },
    }),
  );
  const owner = host.install(
    definePlugin({
      name: "boundary.reader",
      requires: { items },
      setup(ctx) {
        ctx.on(notice, () => undefined);
        ctx.items.subscribe(listener);
      },
    }),
  );
  await host.start();
  listener.mockClear();
  let value = 0;
  const view = host.diagnostics.get().installations.get(owner.id)!.lifetime!;
  const subscription = view.subscribe(() => item.update(++value));
  try {
    await owner.remove();
    expect(value).toBeGreaterThan(0);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    subscription.dispose();
    await host.stop();
  }
});

it("closes all descendant event entrances before cancellation and while tasks settle", async () => {
  const ping = event<void>("boundary.ping");
  const items = extensionPoint<number>("boundary.items");
  const host = createHost();
  const blocked = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let parent!: LifetimeContext;
  let child!: LifetimeContext;
  let emit!: () => Promise<void>;
  const heard = vi.fn<() => void>();
  host.install(
    definePlugin({
      name: "boundary.owner",
      setup(ctx) {
        parent = ctx.lifetime("parent");
        child = parent.lifetime("child").lifetime("grandchild");
        child.on(ping, heard);
        child.contribute(items, "item", 1);
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
  );
  host.install(
    definePlugin({
      name: "boundary.emitter",
      setup(ctx) {
        emit = () => ctx.emit(ping);
      },
    }),
  );
  await host.start();
  const stopping = parent.dispose();
  try {
    await emit();
    await aborted.promise;
    await emit();
    expect(heard).not.toHaveBeenCalled();
    expect(host.contributions(items).get().size).toBe(0);
    expect(() => child.cleanup(() => undefined)).toThrow("Lifetime is disposing");
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
    setup(ctx) {
      received = [ctx.value, ctx.maybe];
    },
  });
  mutable.id = "mutated";
  optionalToken.service.id = "also-mutated";
  const host = createHost();
  host.install(provider);
  host.install(consumer);
  await host.start();
  try {
    expect(host.get(service<number>("boundary.value"))).toBe(7);
    expect(received).toEqual([7, undefined]);
    expect(consumer.requires?.maybe.service.id).toBe("boundary.optional");
    expect(Object.isFrozen(consumer.requires?.maybe.service)).toBe(true);
    expect(Object.isFrozen(mutable)).toBe(false);
  } finally {
    await host.stop();
  }
});

it("allows a cancelling parent task to await its child's disposal", async () => {
  const host = createHost();
  const abortObserved = Promise.withResolvers<void>();
  const escape = Promise.withResolvers<void>();
  let parent!: LifetimeContext;
  let childReleased = false;
  let parentCompleted = false;
  host.install(
    definePlugin({
      name: "boundary.join-child",
      setup(ctx) {
        parent = ctx.lifetime("parent");
        const child = parent.lifetime("child");
        child.cleanup(() => {
          childReleased = true;
        });
        parent.spawn(async (signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                abortObserved.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          await Promise.race([child.dispose(), escape.promise]);
          parentCompleted = true;
        });
      },
    }),
  );
  await host.start();
  const completion = parent.dispose();
  try {
    await abortObserved.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(childReleased).toBe(true);
    expect(parentCompleted).toBe(true);
    expect(parent.dispose()).toBeInstanceOf(Promise);
  } finally {
    escape.resolve();
    await completion;
    await host.stop();
  }
});
