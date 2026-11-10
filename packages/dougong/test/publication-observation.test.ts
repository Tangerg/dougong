import { expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
} from "../src/index";
import type { Contribution } from "../src/index";

const resourceAuthority = createResourceAuthority();

it("publishes dynamic contribution membership and Lifetime ownership before notifying either view", async () => {
  const point = extensionPoint<number>("items");
  let add!: () => Contribution<number>;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ contributions }) {
            add = () => contributions.add(point, "item", 1);
          },
        }),
      },
    ],
  });
  await host.start();
  try {
    const items = host.contributions(point);
    const seen: Array<readonly [number, number]> = [];
    const observe = () => {
      const { lifetime } = host.diagnostics.get().installations[0]!;
      seen.push([lifetime!.publications, items.get().length]);
    };
    using _diagnostics = host.diagnostics.subscribe(observe);
    using _items = items.subscribe(observe);
    const contribution = add();
    contribution[Symbol.dispose]();
    expect(seen).toContainEqual([1, 1]);
    expect(seen).toContainEqual([0, 0]);
    for (const [publications, members] of seen) expect(publications).toBe(members);
  } finally {
    await host.stop();
  }
});

it("broadcasts to available owners while a sealed listener waits for its dependent to stop", async () => {
  const notice = event<void>("notice");
  const value = service<number>("value");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const sealed = vi.fn<() => void>();
  const available = vi.fn<() => void>();
  let emit!: () => Promise<void>;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "listener",
        plugin: definePlugin({
          name: "listener",
          provides: { value },
          setup({ events }) {
            events.on(notice, sealed);
            return { value: 1 };
          },
        }),
      },
      {
        id: "dependent",
        plugin: definePlugin({
          name: "dependent",
          requires: { value },
          setup({ lifetime }) {
            lifetime.defer(() => {
              entered.resolve();
              return resume.promise;
            });
          },
        }),
      },
      {
        id: "unrelated",
        plugin: definePlugin({
          name: "unrelated",
          setup({ events }) {
            events.on(notice, available);
            emit = () => events.emit(notice);
          },
        }),
      },
    ],
  });
  await host.start();
  const change = host.change();
  change.remove(host.installation("listener")!);
  change.remove(host.installation("dependent")!);
  const removing = host.apply(await host.plan(change));
  try {
    await entered.promise;
    await emit();
    expect(sealed).not.toHaveBeenCalled();
    expect(available).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
    await removing;
    await host.stop();
  }
});

it("rejects invalid ownership declarations before either publication can escape to the root", async () => {
  const notice = event<void>("notice");
  const point = extensionPoint<number>("items");
  const readOwner = vi.fn<() => unknown>();
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime, events, contributions }) {
            const child = lifetime.child("session");
            readOwner.mockReturnValue(child);
            const invalid = [
              child,
              { owner: child },
              null,
              Object.defineProperty({}, "lifetime", { enumerable: true, get: readOwner }),
            ];
            for (const options of invalid) {
              expect(() => events.on(notice, () => undefined, options as never)).toThrow(TypeError);
              expect(() => contributions.add(point, "item", 1, options as never)).toThrow(
                TypeError,
              );
            }
            expect(readOwner).not.toHaveBeenCalled();
          },
        }),
      },
    ],
  });
  try {
    await host.start();
    expect(host.diagnostics.get().installations[0]!.lifetime!.publications).toBe(0);
  } finally {
    await host.stop();
  }
});
