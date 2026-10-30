import { expect, it, vi } from "vitest";
import { createHost, definePlugin, optional, service } from "../src/index";

it("captures plugin declarations and configuration before external mutation", async () => {
  const token = service<number>("capture/value");
  const requirements = { input: optional(token) };
  const config = { port: 1 };
  const setup = vi.fn<(_context: unknown, _config: unknown) => void>();
  const plugin = definePlugin({ name: "capture", requires: requirements, setup });
  const host = createHost({ installations: [{ id: "a", plugin, config }] });
  config.port = 2;
  requirements.input = optional(service<number>("capture/other"));
  await host.start();
  expect(setup.mock.calls[0]?.[0]).toMatchObject({ deps: { input: undefined } });
  expect(setup.mock.calls[0]?.[1]).toEqual({ port: 1 });
  await host.stop();
});

it("captures update config when staged and validator output when planned", async () => {
  const seen: unknown[] = [];
  const output = { value: 1 };
  const plugin = definePlugin({
    name: "capture",
    config: {
      "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: output }) },
    },
    setup(_ctx, config) {
      seen.push(config);
    },
  });
  const host = createHost({ installations: [{ id: "a", plugin, config: { input: 1 } }] });
  await host.start();
  const config = { input: 2 };
  const change = host.change();
  change.update(host.installation("a")!, { config });
  config.input = 3;
  const plan = await host.plan(change);
  output.value = 9;
  await host.apply(plan);
  expect(seen).toEqual([{ value: 1 }, { value: 1 }]);
  expect(Object.isFrozen(seen[1])).toBe(true);
  await host.stop();
});

it("replaces source atomically with implementation and preserves it for config-only updates", async () => {
  const plugin = definePlugin({ name: "a", setup() {} });
  const host = createHost({ installations: [{ id: "a", plugin, origin: { version: "1" } }] });
  const id = host.installation("a")!;
  const first = host.change();
  first.update(id, { config: { x: 1 } });
  await host.apply(await host.plan(first));
  expect(id.origin).toEqual({ version: "1" });
  const second = host.change();
  second.update(id, { plugin, origin: { version: "2" } });
  await host.apply(await host.plan(second));
  expect(id.origin).toEqual({ version: "2" });
  const third = host.change();
  third.update(id, { plugin });
  await host.apply(await host.plan(third));
  expect(id.origin).toBeUndefined();
});

it("rejects executable identity data rather than invoking getters", () => {
  const getter = vi.fn<() => string>(() => "unsafe");
  const token = Object.defineProperty({ kind: "service" }, "id", { get: getter, enumerable: true });
  expect(() =>
    definePlugin({ name: "invalid", requires: { value: token as never }, setup() {} }),
  ).toThrow(/data propert/);
  expect(getter).not.toHaveBeenCalled();
});

it("captures optional token identity only once during use", async () => {
  const token = service<number>("capture/optional");
  const host = createHost({
    installations: [
      {
        id: "a",
        plugin: definePlugin({ name: "a", provides: { token }, setup: () => ({ token: 7 }) }),
      },
    ],
  });
  await host.start();
  const wrapper = optional(token);
  expect(await host.use(wrapper, (value) => value)).toBe(7);
  await host.stop();
});
