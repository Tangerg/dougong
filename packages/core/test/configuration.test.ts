import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError, createHost, definePlugin } from "../src/index";

// A config schema is third-party code. Core validates its *result* as untrusted
// input, so a validator that violates the Standard Schema protocol produces an
// error naming the Installation rather than an `undefined` config that fails
// somewhere inside setup().

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
  const host = createHost();
  host.install(plugin, config);
  return host.start().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("Plugin config validation", () => {
  it("names the Installation when a validator returns a non-object result", async () => {
    const failure = await startWith(schemaReturning("not a result"), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message:
        "Installation 'test.config-protocol:1' config validator returned a non-object result",
    });
  });

  it("names the Installation when a validator returns non-array issues", async () => {
    const failure = await startWith(schemaReturning({ issues: { message: "nope" } }), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message: "Installation 'test.config-protocol:1' config validator returned non-array issues",
    });
  });

  it("names the Installation when a validator returns neither value nor issues", async () => {
    const failure = await startWith(schemaReturning({}), 1);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      message:
        "Installation 'test.config-protocol:1' config validator returned neither value nor issues",
    });
  });

  it("treats an explicitly empty issue list as a rejection, not a success", async () => {
    // `issues: []` is present, so the validator said "invalid" without saying
    // why. Reading it as valid would let a schema fail open.
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
    const host = createHost();
    host.install(plugin, { port: "8080" });
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
