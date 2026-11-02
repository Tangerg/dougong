import { runInNewContext } from "node:vm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, it, vi } from "vitest";
import {
  ConfigurationValidationError,
  createHost,
  definePlugin,
  optional,
  service,
} from "../src/index";

it("captures plugin declarations and configuration before external mutation", async () => {
  const token = service<number>("capture/value");
  const requirements = { input: optional(token) };
  const configuration = { port: 1 };
  const setup = vi.fn<(_context: unknown, _configuration: unknown) => void>();
  const plugin = definePlugin({ name: "capture", requires: requirements, setup });
  const host = createHost({ installations: [{ id: "a", plugin, configuration }] });
  configuration.port = 2;
  requirements.input = optional(service<number>("capture/other"));
  await host.start();
  expect(setup.mock.calls[0]?.[0]).toMatchObject({ dependencies: { input: undefined } });
  expect(setup.mock.calls[0]?.[1]).toEqual({ port: 1 });
  await host.stop();
});

it("captures update configuration when staged and validator output when planned", async () => {
  const seen: unknown[] = [];
  const output = { value: 1 };
  const plugin = definePlugin({
    name: "capture",
    configuration: {
      "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: output }) },
    },
    setup(_context, configuration) {
      seen.push(configuration);
    },
  });
  const host = createHost({ installations: [{ id: "a", plugin, configuration: { input: 1 } }] });
  await host.start();
  const configuration = { input: 2 };
  const change = host.change();
  change.update(host.installation("a")!, { configuration });
  configuration.input = 3;
  const plan = await host.plan(change);
  output.value = 9;
  await host.apply(plan);
  expect(seen).toEqual([{ value: 1 }, { value: 1 }]);
  expect(Object.isFrozen(seen[1])).toBe(true);
  await host.stop();
});

it("replaces source atomically with implementation and preserves it for configuration-only updates", async () => {
  const plugin = definePlugin({ name: "a", setup() {} });
  const host = createHost({ installations: [{ id: "a", plugin, origin: { version: "1" } }] });
  const id = host.installation("a")!;
  const first = host.change();
  first.update(id, { configuration: { x: 1 } });
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

it("accepts the same cross-realm Contract identity for provisions, requirements and borrowing", async () => {
  const token = runInNewContext(
    'Object.freeze({kind: "service", id: "realm/value"})',
  ) as ReturnType<typeof service<number>>;
  const provider = definePlugin({
    name: "provider",
    provides: { value: token },
    setup: () => ({ value: 7 }),
  });
  const received = vi.fn<(value: number) => void>();
  const consumer = definePlugin({
    name: "consumer",
    requires: { value: token },
    setup: ({ dependencies }) => received(dependencies.value),
  });
  const host = createHost({
    installations: [
      { id: "provider", plugin: provider },
      { id: "consumer", plugin: consumer },
    ],
  });
  try {
    await host.start();
    expect(received).toHaveBeenCalledExactlyOnceWith(7);
    expect(await host.use(token, (value) => value)).toBe(7);
  } finally {
    await host.stop();
  }
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

it("rejects executable array fields without substituting fabricated declarations or issues", () => {
  const iterator = vi.fn<() => Generator<{ message: string }>>(function* () {
    yield { message: "substituted" };
  });
  for (const key of ["installations", "groups"] as const) {
    const array = Object.assign([], { [Symbol.iterator]: iterator });
    expect(() => createHost({ [key]: array })).toThrow(/dense/);
  }
  const issues = Object.assign([{ message: "real" }], { [Symbol.iterator]: iterator });
  expect(() => new ConfigurationValidationError(issues)).toThrow(/dense/);
  expect(iterator).not.toHaveBeenCalled();
});

it("preserves Standard Schema options and method identity through capture", () => {
  const validate = vi.fn<StandardSchemaV1.Props<unknown, unknown>["validate"]>(
    (_input, options) => ({
      value: options?.libraryOptions?.mode,
    }),
  );
  const standard = { version: 1 as const, vendor: "test", validate };
  const plugin = definePlugin({
    name: "validation.options",
    configuration: { "~standard": standard },
    setup() {},
  });
  const options = { libraryOptions: { mode: "strict" } };
  expect(plugin.configuration!["~standard"].validate(null, options)).toEqual({ value: "strict" });
  expect(validate.mock.contexts).toEqual([standard]);
  expect(validate).toHaveBeenCalledExactlyOnceWith(null, options);
});

it("rejects duplicate installation IDs before reading the conflicting initial Plugin and retains the committed identity on a failed Plan", async () => {
  const plugin = definePlugin({ name: "unique", setup() {} });
  const conflicting = new Proxy(plugin, {
    getPrototypeOf() {
      throw new Error("conflicting Plugin should not be inspected");
    },
  });
  const original = { id: "same", plugin };
  const conflict = { code: "INSTALLATION_CONFLICT" };
  expect(() =>
    createHost({ installations: [original, { id: original.id, plugin: conflicting }] }),
  ).toThrowError(expect.objectContaining(conflict));
  const host = createHost({ installations: [original] });
  const committed = host.installation(original.id)!;
  const change = host.change();
  change.remove(committed);
  const replacement = change.install(plugin, { id: original.id });
  await expect(host.plan(change)).rejects.toMatchObject(conflict);
  expect(host.installation(original.id)).toBe(committed);
  expect(replacement.status).toBe("removed");
});
