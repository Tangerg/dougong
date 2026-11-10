import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { expect, it, vi } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  extensionPoint,
  optional,
  service,
  ConfigurationValidationError,
} from "../src/index.js";
import { describePlugin } from "../src/composition/plugin-description.js";

const resourceAuthority = createResourceAuthority();

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
    configuration: { status: "schemaAbsent" },
  });
  expect(setup).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(Object.isFrozen(descriptor.requires)).toBe(true);
  expect(Object.isFrozen(descriptor.requires[0])).toBe(true);
  expect(Object.isFrozen(descriptor.provides)).toBe(true);
  expect(Object.isFrozen(descriptor.provides[0])).toBe(true);
  expect(Object.isFrozen(descriptor.configuration)).toBe(true);
});

it("distinguishes a validator without an exporter from an absent schema", () => {
  const validate = vi.fn<StandardSchemaV1<string, number>["~standard"]["validate"]>(() => ({
    value: 1,
  }));
  const plugin = definePlugin({
    name: "description.validator",
    configuration: { "~standard": { version: 1, vendor: "validation-only", validate } },
    setup() {},
  });
  expect(describePlugin(plugin).configuration).toEqual({
    status: "unavailable",
    vendor: "validation-only",
  });
  expect(validate).not.toHaveBeenCalled();
});

it("describes schema absence without claiming a required typed configuration is absent", async () => {
  const received = vi.fn<(configuration: { readonly port: number }) => void>();
  const plugin = definePlugin<{ port: number }>({
    name: "description.schema-free",
    setup(_context, configuration) {
      received(configuration);
    },
  });
  expect(describePlugin(plugin).configuration).toEqual({ status: "schemaAbsent" });
  expect(received).not.toHaveBeenCalled();
  const host = createHost({
    resourceAuthority,
    installations: [{ id: "configured", plugin, configuration: { port: 8080 } }],
  });
  try {
    await host.start();
    expect(received).toHaveBeenCalledExactlyOnceWith({ port: 8080 });
    expect(Object.isFrozen(received.mock.calls[0]![0])).toBe(true);
  } finally {
    await host.stop();
  }
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
    configuration: schema,
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
  expect(descriptor.configuration).toEqual({
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
  expect(descriptor.configuration).toMatchObject({
    input: { type: "string" },
    output: { minimum: 0 },
  });
  if (descriptor.configuration.status !== "available") throw new Error("Expected exported schemas");
  expect(Object.isFrozen(descriptor.configuration.input)).toBe(true);
  expect(Object.isFrozen(descriptor.configuration.output)).toBe(true);
  expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  expect(describePlugin(plugin, { jsonSchemaTarget: "draft-07" }).configuration).toMatchObject({
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
    configuration: {
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
  const setup = vi.fn<(configuration: number) => void>();
  const plugin = definePlugin({
    name: "description.planned",
    configuration: schema,
    setup(_context, configuration) {
      setup(configuration);
    },
  });
  const host = createHost({ resourceAuthority });
  await host.start();
  const change = host.change();
  change.install(plugin, { id: "configured", configuration: "42" });
  const plan = await host.plan(change);
  expect(validate).toHaveBeenCalledOnce();
  expect(setup).not.toHaveBeenCalled();
  await host.apply(plan);
  expect(setup).toHaveBeenCalledExactlyOnceWith(42);
  expect(validate).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(describePlugin(plugin).configuration).toMatchObject({ status: "available" });
  expect(input).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledOnce();
  await host.stop();
});

it("rejects a malformed optional JSON Schema protocol at declaration capture", () => {
  const declaration = {
    name: "description.invalid-exporter",
    configuration: {
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
      configuration: {
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
  const failure = new Error("asynchronous export failed");
  const observe = vi.fn<(resolve: unknown, reject: (error: unknown) => void) => void>(
    (_resolve, reject) => reject(failure),
  );
  const declaration = {
    name: "description.asynchronous-exporter",
    configuration: {
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
    configuration: {
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
    resourceAuthority,
    installations: [
      { id: "valid", plugin, configuration: 1 },
      { id: "invalid", plugin, configuration: -1 },
    ],
  });
  const change = host.change();
  change.update(host.installation("valid")!, { configuration: 2 });
  change.update(host.installation("invalid")!, { configuration: -2 });
  const failure = await host.plan(change).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ConfigurationValidationError);
  expect(failure).toMatchObject({
    code: "CONFIGURATION_INVALID",
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

it("keeps ConfigurationValidationError issues as captured data while accepting structured context", () => {
  const cause = new Error("validator cause");
  const failure = new ConfigurationValidationError([{ message: "Invalid field" }], {
    cause,
    details: { installation: "example", phase: "configuration", outcome: "rejected" },
  });
  expect(failure.cause).toBe(cause);
  expect(failure.details).toMatchObject({ installation: "example", phase: "configuration" });
  expect(Object.isFrozen(failure.details)).toBe(true);
  expect(Object.isFrozen(failure.issues)).toBe(true);
});
