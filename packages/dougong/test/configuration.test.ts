import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ConfigurationValidationError,
  captureConfiguration,
  createHost,
  definePlugin,
} from "../src/index";

function schemaReturning(result: unknown): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => result as never,
    },
  };
}

async function startWith(schema: StandardSchemaV1<unknown, unknown>, configuration: unknown) {
  const plugin = definePlugin({
    name: "test.configuration-protocol",
    configuration: schema,
    setup: () => undefined,
  });
  const host = createHost({ installations: [{ id: "configuration", plugin, configuration }] });
  return host.start().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("Plugin configuration validation", () => {
  it.each([
    ["promise", Promise.resolve(1)],
    ["function", () => 1],
    ["date", new Date(0)],
    ["map", new Map()],
    ["set", new Set()],
    ["infinity", Infinity],
    ["NaN", NaN],
    ["bigint", 1n],
    ["symbol", Symbol("configuration")],
    ["sparse array", Array(2)],
    ["undefined array item", [undefined]],
    ["symbol key", { [Symbol("key")]: 1 }],
    ["hidden property", Object.defineProperty({}, "secret", { value: 1 })],
  ])("rejects %s outside the immutable configuration value domain", (_label, value) => {
    expect(() => captureConfiguration(value)).toThrow(TypeError);
  });

  it("copies records and dense arrays without retaining caller mutation", () => {
    const input = { values: [1, { enabled: true }], optional: undefined };
    const captured = captureConfiguration(input);
    input.values[0] = 9;
    expect(captured).toEqual({ values: [1, { enabled: true }] });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured as { values: unknown }).values)).toBe(true);
    expect(captureConfiguration(undefined)).toBeUndefined();
    expect(captureConfiguration(null)).toBeNull();
    expect(captureConfiguration("text")).toBe("text");
    expect(captureConfiguration(false)).toBe(false);
  });

  it("rejects accessors without executing them", () => {
    const getter = vi.fn<() => number>(() => 1);
    const input = Object.defineProperty({}, "port", { enumerable: true, get: getter });
    expect(() => captureConfiguration(input)).toThrow(
      "configuration field 'port' must be a data property",
    );
    expect(getter).not.toHaveBeenCalled();
    const array = Object.defineProperty([1], "0", { get: getter });
    expect(() => captureConfiguration(array)).toThrow(/data properties/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects cycles and excessive depth but permits shared data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => captureConfiguration(cyclic)).toThrow(/Circular configuration/);
    let nested: unknown = null;
    for (let depth = 0; depth < 66; depth++) nested = { child: nested };
    expect(() => captureConfiguration(nested)).toThrow(/nesting depth/);
    const shared = { enabled: true };
    expect(captureConfiguration({ left: shared, right: shared })).toEqual({
      left: shared,
      right: shared,
    });
  });

  it("rejects unsupported input before planning can execute setup", () => {
    const setup = vi.fn<() => undefined>(() => undefined);
    const plugin = definePlugin<unknown>({ name: "configuration", setup });
    expect(() =>
      createHost({
        installations: [{ id: "configuration", plugin, configuration: Promise.resolve(1) }],
      }),
    ).toThrow("configuration must be a plain record");
    expect(setup).not.toHaveBeenCalled();
  });

  it("awaits validation while rejecting a Promise as the validated value", async () => {
    const failure = await startWith(
      schemaReturning(Promise.resolve({ value: Promise.resolve(1) })),
      "input",
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ message: "configuration must be a plain record" });
  });

  it("names the Installation when a validator returns a non-object result", async () => {
    const failure = await startWith(schemaReturning("not a result"), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'configuration' configuration validator returned a non-object result",
    });
  });

  it("names the Installation when a validator returns non-array issues", async () => {
    const failure = await startWith(schemaReturning({ issues: { message: "nope" } }), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'configuration' configuration validator returned non-array issues",
    });
  });

  it("names the Installation when a validator returns neither value nor issues", async () => {
    const failure = await startWith(schemaReturning({}), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message:
        "Installation 'configuration' configuration validator returned neither value nor issues",
    });
  });

  it("treats an explicitly empty issue list as a rejection, not a success", async () => {
    const failure = await startWith(schemaReturning({ issues: [] }), 1);

    expect(failure).toBeInstanceOf(ConfigurationValidationError);
    expect(failure).toMatchObject({ code: "CONFIGURATION_INVALID", issues: [] });
  });

  it("passes the resolved value through rather than the caller's input", async () => {
    let received: unknown;
    const plugin = definePlugin({
      name: "test.configuration-transform",
      configuration: schemaReturning({ value: { port: 8080 } }),
      setup: (_context, configuration) => {
        received = configuration;
      },
    });
    const host = createHost({
      installations: [{ id: "configuration", plugin, configuration: { port: "8080" } }],
    });
    await host.start();

    expect(received).toEqual({ port: 8080 });
    await host.stop();
  });

  it("copies validation issues so a retained error cannot be edited afterwards", () => {
    const issues = [{ message: "port is required", path: ["port"] }];
    const error = new ConfigurationValidationError(issues);

    issues[0] = { message: "rewritten", path: [] };

    expect(error.issues).toEqual([{ message: "port is required", path: ["port"] }]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.message).toContain("port is required");
  });

  it("rejects issue shapes that could not be reported to a caller", () => {
    expect(() => new ConfigurationValidationError({} as never)).toThrowError(
      new TypeError("Configuration validation issues must be an array"),
    );
    expect(() => new ConfigurationValidationError([null] as never)).toThrowError(
      new TypeError("Configuration validation issue at index 0 must be an object"),
    );
    expect(() => new ConfigurationValidationError([{ message: 1 }] as never)).toThrowError(
      new TypeError("Configuration validation issue at index 0 message must be a string"),
    );
    expect(
      () => new ConfigurationValidationError([{ message: "bad", path: "port" }] as never),
    ).toThrowError(
      new TypeError("Configuration validation issue at index 0 path must be an array"),
    );
    expect(
      () => new ConfigurationValidationError([{ message: "bad", path: [{}] }] as never),
    ).toThrowError(
      new TypeError(
        "Configuration validation issue at index 0 path segment 0 must contain a property key",
      ),
    );
  });
});
