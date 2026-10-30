import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError, captureConfig, createHost, definePlugin } from "../src/index";

function schemaReturning(result: unknown): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => result as never,
    },
  };
}

async function startWith(schema: StandardSchemaV1<unknown, unknown>, config: unknown) {
  const plugin = definePlugin({
    name: "test.config-protocol",
    config: schema,
    setup: () => undefined,
  });
  const host = createHost({ installations: [{ id: "config", plugin, config }] });
  return host.start().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("Plugin config validation", () => {
  it.each([
    ["promise", Promise.resolve(1)],
    ["function", () => 1],
    ["date", new Date(0)],
    ["map", new Map()],
    ["set", new Set()],
    ["infinity", Infinity],
    ["NaN", NaN],
    ["bigint", 1n],
    ["symbol", Symbol("config")],
    ["sparse array", Array(2)],
    ["undefined array item", [undefined]],
    ["symbol key", { [Symbol("key")]: 1 }],
    ["hidden property", Object.defineProperty({}, "secret", { value: 1 })],
  ])("rejects %s outside the immutable config value domain", (_label, value) => {
    expect(() => captureConfig(value)).toThrow(TypeError);
  });

  it("copies records and dense arrays without retaining caller mutation", () => {
    const input = { values: [1, { enabled: true }], optional: undefined };
    const captured = captureConfig(input);
    input.values[0] = 9;
    expect(captured).toEqual({ values: [1, { enabled: true }] });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured as { values: unknown }).values)).toBe(true);
    expect(captureConfig(undefined)).toBeUndefined();
    expect(captureConfig(null)).toBeNull();
    expect(captureConfig("text")).toBe("text");
    expect(captureConfig(false)).toBe(false);
  });

  it("rejects accessors without executing them", () => {
    const getter = vi.fn<() => number>(() => 1);
    const input = Object.defineProperty({}, "port", { enumerable: true, get: getter });
    expect(() => captureConfig(input)).toThrow(/data properties/);
    expect(getter).not.toHaveBeenCalled();
    const array = Object.defineProperty([1], "0", { get: getter });
    expect(() => captureConfig(array)).toThrow(/data properties/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects cycles and excessive depth but permits shared data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => captureConfig(cyclic)).toThrow(/Circular config/);
    let nested: unknown = null;
    for (let i = 0; i < 66; i++) nested = { child: nested };
    expect(() => captureConfig(nested)).toThrow(/nesting depth/);
    const shared = { enabled: true };
    expect(captureConfig({ left: shared, right: shared })).toEqual({
      left: shared,
      right: shared,
    });
  });

  it("rejects unsupported input before planning can execute setup", () => {
    const setup = vi.fn<() => undefined>(() => undefined);
    const plugin = definePlugin<unknown>({ name: "config", setup });
    expect(() =>
      createHost({
        installations: [{ id: "config", plugin, config: Promise.resolve(1) }],
      }),
    ).toThrow(/plain records/);
    expect(setup).not.toHaveBeenCalled();
  });

  it("awaits validation while rejecting a Promise as the validated value", async () => {
    const failure = await startWith(
      schemaReturning(Promise.resolve({ value: Promise.resolve(1) })),
      "input",
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/plain records/) });
  });

  it("names the Installation when a validator returns a non-object result", async () => {
    const failure = await startWith(schemaReturning("not a result"), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'config' config validator returned a non-object result",
    });
  });

  it("names the Installation when a validator returns non-array issues", async () => {
    const failure = await startWith(schemaReturning({ issues: { message: "nope" } }), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'config' config validator returned non-array issues",
    });
  });

  it("names the Installation when a validator returns neither value nor issues", async () => {
    const failure = await startWith(schemaReturning({}), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'config' config validator returned neither value nor issues",
    });
  });

  it("treats an explicitly empty issue list as a rejection, not a success", async () => {
    const failure = await startWith(schemaReturning({ issues: [] }), 1);

    expect(failure).toBeInstanceOf(ConfigValidationError);
    expect(failure).toMatchObject({ code: "CONFIG_INVALID", issues: [] });
  });

  it("passes the resolved value through rather than the caller's input", async () => {
    let received: unknown;
    const plugin = definePlugin({
      name: "test.config-transform",
      config: schemaReturning({ value: { port: 8080 } }),
      setup: (_ctx, config) => {
        received = config;
      },
    });
    const host = createHost({
      installations: [{ id: "config", plugin, config: { port: "8080" } }],
    });
    await host.start();

    expect(received).toEqual({ port: 8080 });
    await host.stop();
  });

  it("copies validation issues so a retained error cannot be edited afterwards", () => {
    const issues = [{ message: "port is required", path: ["port"] }];
    const error = new ConfigValidationError(issues);

    issues[0] = { message: "rewritten", path: [] };

    expect(error.issues).toEqual([{ message: "port is required", path: ["port"] }]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.message).toContain("port is required");
  });

  it("rejects issue shapes that could not be reported to a caller", () => {
    expect(() => new ConfigValidationError({} as never)).toThrowError(
      new TypeError("Config validation issues must be an array"),
    );
    expect(() => new ConfigValidationError([null] as never)).toThrowError(
      new TypeError("Config validation issue at index 0 must be an object"),
    );
    expect(() => new ConfigValidationError([{ message: 1 }] as never)).toThrowError(
      new TypeError("Config validation issue at index 0 message must be a string"),
    );
    expect(
      () => new ConfigValidationError([{ message: "bad", path: "port" }] as never),
    ).toThrowError(new TypeError("Config validation issue at index 0 path must be an array"));
    expect(() => new ConfigValidationError([{ message: "bad", path: [{}] }] as never)).toThrowError(
      new TypeError(
        "Config validation issue at index 0 path segment 0 must contain a property key",
      ),
    );
  });
});
