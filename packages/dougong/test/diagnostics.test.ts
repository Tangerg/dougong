import { expect, it } from "vitest";
import { createHost, definePlugin, type LifetimeContext } from "../src/index";

it("caches immutable projections while resource changes do not advance stateRevision", async () => {
  let scope!: LifetimeContext;
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          setup({ lifetime }) {
            scope = lifetime;
          },
        }),
      },
    ],
  });
  expect(host.diagnostics.get()).toBe(host.diagnostics.get());
  await host.start();
  const before = host.diagnostics.get(),
    revision = host.stateRevision;
  const cleanup = scope.defer(() => undefined);
  const after = host.diagnostics.get();
  expect(after).not.toBe(before);
  expect(after.stateRevision).toBe(revision);
  expect(Object.isFrozen(after.installations)).toBe(true);
  expect(host.diagnostics.get()).toBe(after);
  await cleanup[Symbol.asyncDispose]();
  expect(host.diagnostics.get()).not.toBe(after);
  await host.stop();
  expect(host.diagnostics.get().installations[0]?.lifetime).toBeUndefined();
});
