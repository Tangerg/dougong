import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  extensionPoint,
  optional,
  service,
  ConfigValidationError,
} from "../src/index.js";
import { describePlugin } from "../src/composition/plugin-description.js";

it("derives immutable contract descriptions without running setup", () => {
  const value = service<number>("description/value");
  const absent = service<string>("description/optional");
  const items = extensionPoint<string>("description/items");
  const result = service<boolean>("description/result");
  const requires = { value, absent: optional(absent), items };
  const setup = vi.fn<() => { result: boolean }>(() => ({ result: true }));
  const plugin = definePlugin({
    name: "description.plugin",
    requires,
    provides: { result },
    setup,
  });
  requires.value = service<number>("description/replaced");
  const descriptor = describePlugin(plugin);
  expect(descriptor).toEqual({
    name: "description.plugin",
    requires: [
      { alias: "value", id: value.id, kind: "service", optional: false },
      { alias: "absent", id: absent.id, kind: "service", optional: true },
      { alias: "items", id: items.id, kind: "extensionPoint", optional: false },
    ],
    provides: [{ alias: "result", id: result.id }],
    config: { status: "none" },
  });
  expect(setup).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(Object.isFrozen(descriptor.requires)).toBe(true);
  expect(Object.isFrozen(descriptor.requires[0])).toBe(true);
  expect(Object.isFrozen(descriptor.provides)).toBe(true);
  expect(Object.isFrozen(descriptor.provides[0])).toBe(true);
  expect(Object.isFrozen(descriptor.config)).toBe(true);
});

it("distinguishes a validator without an exporter from a Plugin without configuration", () => {
  const validate = vi.fn<StandardSchemaV1<string, number>["~standard"]["validate"]>(() => ({
    value: 1,
  }));
  const plugin = definePlugin({
    name: "description.validator",
    config: { "~standard": { version: 1, vendor: "validation-only", validate } },
    setup() {},
  });
  expect(describePlugin(plugin).config).toEqual({
    status: "unavailable",
    vendor: "validation-only",
  });
  expect(validate).not.toHaveBeenCalled();
});

it("captures standard JSON Schema methods and receivers and only exports on explicit description", () => {
  const calls: Array<readonly [string, string]> = [];
  const input = { type: "string", description: "A numeric string" };
  const output = { type: "number", minimum: 0 };
  const converter = {
    input(options: StandardJSONSchemaV1.Options) {
      expect(this).toBe(converter);
      calls.push(["input", options.target]);
      return input;
    },
    output(options: StandardJSONSchemaV1.Options) {
      expect(this).toBe(converter);
      calls.push(["output", options.target]);
      return output;
    },
  };
  const validate = vi.fn<StandardSchemaV1<string, number>["~standard"]["validate"]>(() => ({
    value: 1,
  }));
  const schema: StandardSchemaV1<string, number> & StandardJSONSchemaV1<string, number> = {
    "~standard": { version: 1, vendor: "test", validate, jsonSchema: converter },
  };
  const plugin = definePlugin({
    name: "description.exporter",
    config: schema,
    setup() {},
  });
  expect(calls).toEqual([]);
  converter.input = () => {
    throw new Error("replaced input method");
  };
  converter.output = () => {
    throw new Error("replaced output method");
  };
  const descriptor = describePlugin(plugin);
  expect(descriptor.config).toEqual({
    status: "available",
    vendor: "test",
    target: "draft-2020-12",
    input,
    output,
  });
  expect(calls).toEqual([
    ["input", "draft-2020-12"],
    ["output", "draft-2020-12"],
  ]);
  input.type = "mutated";
  output.minimum = 5;
  expect(descriptor.config).toMatchObject({ input: { type: "string" }, output: { minimum: 0 } });
  if (descriptor.config.status !== "available") throw new Error("Expected exported schemas");
  expect(Object.isFrozen(descriptor.config.input)).toBe(true);
  expect(Object.isFrozen(descriptor.config.output)).toBe(true);
  expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  expect(describePlugin(plugin, { jsonSchemaTarget: "draft-07" }).config).toMatchObject({
    target: "draft-07",
  });
  expect(calls.slice(-2)).toEqual([
    ["input", "draft-07"],
    ["output", "draft-07"],
  ]);
  expect(validate).not.toHaveBeenCalled();
});

it("preserves a schema exporter failure instead of claiming the validator is undescribable", () => {
  const failure = new Error("target not supported");
  const output = vi.fn<StandardJSONSchemaV1.Converter["output"]>(() => ({}));
  const plugin = definePlugin({
    name: "description.failed-export",
    config: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: undefined }),
        jsonSchema: {
          input() {
            throw failure;
          },
          output,
        },
      },
    },
    setup() {},
  });
  expect(() => describePlugin(plugin)).toThrow(failure);
  expect(output).not.toHaveBeenCalled();
});

it("keeps schema export separate from Plan validation and execution", async () => {
  const input = vi.fn<StandardJSONSchemaV1.Converter["input"]>(() => ({ type: "string" }));
  const output = vi.fn<StandardJSONSchemaV1.Converter["output"]>(() => ({ type: "number" }));
  const validate = vi.fn<StandardSchemaV1<string, number>["~standard"]["validate"]>((value) => ({
    value: Number(value),
  }));
  const schema: StandardSchemaV1<string, number> & StandardJSONSchemaV1<string, number> = {
    "~standard": { version: 1, vendor: "test", validate, jsonSchema: { input, output } },
  };
  const setup = vi.fn<(config: number) => void>();
  const plugin = definePlugin({
    name: "description.planned",
    config: schema,
    setup(_ctx, config) {
      setup(config);
    },
  });
  const host = createHost();
  await host.start();
  const change = host.change();
  change.install(plugin, { id: "configured", config: "42" });
  const plan = await host.plan(change);
  expect(validate).toHaveBeenCalledOnce();
  expect(setup).not.toHaveBeenCalled();
  await host.apply(plan);
  expect(setup).toHaveBeenCalledExactlyOnceWith(42);
  expect(validate).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(describePlugin(plugin).config).toMatchObject({ status: "available" });
  expect(input).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledOnce();
  await host.stop();
});

it("rejects a malformed optional JSON Schema protocol at declaration capture", () => {
  const declaration = {
    name: "description.invalid-exporter",
    config: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: undefined }),
        jsonSchema: { input: 1, output: () => ({}) },
      },
    },
    setup() {},
  };
  expect(() => Reflect.apply(definePlugin, undefined, [declaration])).toThrow("jsonSchema");
});

it.each([new Date(0), { type: "string", extension() {} }, []])(
  "rejects a non-data JSON Schema output %s",
  (value) => {
    const declaration = {
      name: "description.invalid-data",
      config: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ value: undefined }),
          jsonSchema: { input: () => value, output: () => ({}) },
        },
      },
      setup() {},
    };
    expect(() => describePlugin(declaration)).toThrow(TypeError);
  },
);

it("observes an invalid asynchronous exporter rejection", async () => {
  const failure = new Error("async export failed");
  const observe = vi.fn<(resolve: unknown, reject: (error: unknown) => void) => void>(
    (_resolve, reject) => reject(failure),
  );
  const declaration = {
    name: "description.async-exporter",
    config: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: undefined }),
        jsonSchema: {
          // oxlint-disable-next-line unicorn/no-thenable -- invalid asynchronous exporter regression
          input: () => ({ then: observe }),
          output: () => ({}),
        },
      },
    },
    setup() {},
  };
  expect(() => describePlugin(declaration)).toThrow("synchronous");
  await Promise.resolve();
  expect(observe).toHaveBeenCalledOnce();
});

it("validates description options without executing a Plugin", () => {
  const setup = vi.fn<() => void>();
  const plugin = definePlugin({ name: "description.options", setup });
  expect(() => describePlugin(plugin, { jsonSchemaTarget: " " })).toThrow("target");
  expect(() => Reflect.apply(describePlugin, undefined, [plugin, { unsupported: true }])).toThrow(
    "unsupported",
  );
  expect(setup).not.toHaveBeenCalled();
});

it("identifies the failing Installation when a Plan validates several configurations", async () => {
  const issues = [{ message: "Expected a positive number", path: ["capacity"] }];
  const plugin = definePlugin({
    name: "description.configuration-location",
    config: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(input) {
          return typeof input === "number" && input > 0 ? { value: input } : { issues };
        },
      },
    },
    setup() {},
  });
  const host = createHost({
    installations: [
      { id: "valid", plugin, config: 1 },
      { id: "invalid", plugin, config: -1 },
    ],
  });
  const change = host.change();
  change.update(host.installation("valid")!, { config: 2 });
  change.update(host.installation("invalid")!, { config: -2 });
  const failure = await host.plan(change).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ConfigValidationError);
  expect(failure).toMatchObject({
    code: "CONFIG_INVALID",
    details: {
      installation: "invalid",
      phase: "configuration",
      outcome: "rejected",
    },
    issues,
  });
  issues[0]!.message = "changed after validation";
  expect(failure).toMatchObject({ issues: [{ message: "Expected a positive number" }] });
  expect(host.stateRevision).toBe(0);
});

it("keeps ConfigValidationError issues as captured data while accepting structured context", () => {
  const cause = new Error("validator cause");
  const failure = new ConfigValidationError([{ message: "Invalid field" }], {
    cause,
    details: { installation: "example", phase: "configuration", outcome: "rejected" },
  });
  expect(failure.cause).toBe(cause);
  expect(failure.details).toMatchObject({ installation: "example", phase: "configuration" });
  expect(Object.isFrozen(failure.details)).toBe(true);
  expect(Object.isFrozen(failure.issues)).toBe(true);
});
