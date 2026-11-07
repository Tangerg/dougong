import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ConfigurationValidationError,
  captureConfiguration,
  createHost,
  definePlugin,
  type InstallationArguments,
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
  it.each([false, true])(
    "preserves paired input through installation and replacement (configured: %s)",
    async (configured) => {
      const received: unknown[] = [];
      const schema: StandardSchemaV1<string, number> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (input) => ({ value: Number(input) }),
        },
      };
      const parsed = definePlugin({
        name: "configuration.parsed",
        configuration: schema,
        setup(_context, configuration) {
          received.push(configuration);
        },
      });
      const unconfigured = definePlugin({
        name: "configuration.unconfigured",
        setup(_context, configuration) {
          received.push(configuration);
        },
      });
      const declaration: InstallationArguments<typeof parsed | typeof unconfigured> = configured
        ? [parsed, { id: "selected", configuration: "42" }]
        : [unconfigured, { id: "selected" }];
      const host = createHost();
      const change = host.change();
      const installation = change.install(...declaration);

      try {
        await host.apply(await host.plan(change));
        await host.start();
        expect(installation.status).toBe("running");
        expect(received).toEqual(configured ? [42] : [undefined]);

        const replacement = configured
          ? { plugin: unconfigured, configuration: undefined }
          : { plugin: parsed, configuration: "43" };
        const update = host.change();
        update.update(installation, replacement);
        await host.apply(await host.plan(update));
        expect(received).toEqual(configured ? [42, undefined] : [undefined, 43]);
      } finally {
        await host.stop();
      }
    },
  );

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
    ["array metadata", Object.assign([1], { source: "configuration" })],
    ["symbol array metadata", Object.assign([1], { [Symbol("source")]: "configuration" })],
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

  it("captures mutable schema output before setup receives its deeply readonly view", async () => {
    interface Output {
      nested: { count: number };
      values: number[];
    }
    const output: Output = { nested: { count: 1 }, values: [1, 2] };
    const validate = vi.fn<StandardSchemaV1<string, Output>["~standard"]["validate"]>(() => ({
      value: output,
    }));
    const schema: StandardSchemaV1<string, Output> = {
      "~standard": { version: 1, vendor: "test", validate },
    };
    const received = vi.fn<(configuration: unknown) => void>();
    const plugin = definePlugin({
      name: "configuration.readonly-output",
      configuration: schema,
      setup(_context, configuration) {
        expect(Object.isFrozen(configuration)).toBe(true);
        expect(Object.isFrozen(configuration.nested)).toBe(true);
        expect(Object.isFrozen(configuration.values)).toBe(true);
        received(configuration);
      },
    });
    const host = createHost();
    const change = host.change();
    change.install(plugin, { id: "configured", configuration: "input" });
    const plan = await host.plan(change);
    output.nested.count = 9;
    output.values.push(3);
    try {
      await host.apply(plan);
      await host.start();
      expect(validate).toHaveBeenCalledExactlyOnceWith("input");
      expect(received).toHaveBeenCalledExactlyOnceWith({ nested: { count: 1 }, values: [1, 2] });
    } finally {
      await host.stop();
    }
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

  it.each([false, true])(
    "honors inherited Standard Schema issues before a competing value (async: %s)",
    async (asynchronous) => {
      const issues = vi.fn<() => ReadonlyArray<StandardSchemaV1.Issue>>(() => [
        { message: "Configuration must be rejected" },
      ]);
      class RejectedResult implements StandardSchemaV1.FailureResult {
        readonly value = 7;
        get issues() {
          return issues();
        }
      }
      const result = new RejectedResult();
      const schema: StandardSchemaV1<unknown, number> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => (asynchronous ? Promise.resolve(result) : result),
        },
      };
      const setup = vi.fn<() => void>();
      const host = createHost({
        installations: [
          {
            id: "configuration",
            plugin: definePlugin({ name: "configuration", configuration: schema, setup }),
          },
        ],
      });
      try {
        await expect(host.start()).rejects.toMatchObject({
          code: "CONFIGURATION_INVALID",
          issues: [{ message: "Configuration must be rejected" }],
        });
        expect(setup).not.toHaveBeenCalled();
        expect(issues).toHaveBeenCalledOnce();
      } finally {
        await host.stop();
      }
    },
  );

  it.each([7, undefined])("captures inherited success members once (value: %s)", async (value) => {
    const readValue = vi.fn<() => number | undefined>(() => value);
    const readIssues = vi.fn<() => undefined>(() => undefined);
    class AcceptedResult implements StandardSchemaV1.SuccessResult<number | undefined> {
      get value() {
        return readValue();
      }
      get issues() {
        return readIssues();
      }
    }
    const schema: StandardSchemaV1<unknown, number | undefined> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => new AcceptedResult(),
      },
    };
    const received: unknown[] = [];
    const host = createHost({
      installations: [
        {
          id: "configuration",
          plugin: definePlugin({
            name: "configuration",
            configuration: schema,
            setup(_context, configuration) {
              received.push(configuration);
            },
          }),
        },
      ],
    });
    try {
      await host.start();
      expect(received).toEqual([value]);
      expect(readIssues).toHaveBeenCalledOnce();
      expect(readValue).toHaveBeenCalledOnce();
    } finally {
      await host.stop();
    }
  });

  it.each(["issues", "value"])("propagates a result's failing %s accessor once", async (field) => {
    const failure = new Error("Validation result is unreadable");
    const read = vi.fn<() => never>(() => {
      throw failure;
    });
    const result: unknown = Object.create(Object.defineProperty({}, field, { get: read }));
    expect(await startWith(schemaReturning(result), undefined)).toBe(failure);
    expect(read).toHaveBeenCalledOnce();
  });

  it("accepts a callable result without invoking it as configuration or validation", async () => {
    const callable = vi.fn<() => void>();
    const result = Object.assign(callable, { value: 7 });
    const schema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => result,
      },
    };
    const received: unknown[] = [];
    const host = createHost({
      installations: [
        {
          id: "configuration",
          plugin: definePlugin({
            name: "configuration",
            configuration: schema,
            setup(_context, configuration) {
              received.push(configuration);
            },
          }),
        },
      ],
    });
    try {
      await host.start();
      expect(received).toEqual([7]);
      expect(callable).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
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

  it.each([false, true])(
    "captures callable Standard Schema issues and path segments without invoking them (async: %s)",
    async (asynchronous) => {
      const segment = Object.assign(vi.fn<() => void>(), { key: "port" });
      const issue = Object.assign(vi.fn<() => void>(), {
        message: "Expected a port",
        path: [segment],
      });
      const result: StandardSchemaV1.FailureResult = { issues: [issue] };
      const failure = await startWith(
        schemaReturning(asynchronous ? Promise.resolve(result) : result),
        {},
      );

      expect(failure).toBeInstanceOf(ConfigurationValidationError);
      expect(failure).toMatchObject({
        code: "CONFIGURATION_INVALID",
        issues: [{ message: "Expected a port", path: [{ key: "port" }] }],
      });
      expect(issue).not.toHaveBeenCalled();
      expect(segment).not.toHaveBeenCalled();
      issue.message = "Rewritten";
      segment.key = "changed";
      expect((failure as ConfigurationValidationError).issues).toEqual([
        { message: "Expected a port", path: [{ key: "port" }] },
      ]);
    },
  );

  it("captures inherited issue members and array accessors once, ignoring unrelated metadata", () => {
    const metadata = vi.fn<() => never>(() => {
      throw new Error("Metadata must not be read");
    });
    const readKey = vi.fn<() => string>(() => "port");
    class Segment implements StandardSchemaV1.PathSegment {
      get key() {
        return readKey();
      }
    }
    const segment = new Segment();
    const readSegment = vi.fn<() => StandardSchemaV1.PathSegment>(() => segment);
    const path = Object.defineProperties([segment], {
      0: { get: readSegment },
      metadata: { get: metadata },
      [Symbol.iterator]: { get: metadata },
    });
    const readMessage = vi.fn<() => string>(() => "Expected a port");
    const readPath = vi.fn<() => typeof path>(() => path);
    class Issue implements StandardSchemaV1.Issue {
      get message() {
        return readMessage();
      }
      get path() {
        return readPath();
      }
    }
    const issue = new Issue();
    const readIssue = vi.fn<() => StandardSchemaV1.Issue>(() => issue);
    const issues = Object.defineProperties([issue], {
      0: { get: readIssue },
      map: { get: metadata },
      [Symbol("metadata")]: { get: metadata },
    });

    const failure = new ConfigurationValidationError(issues);

    expect(failure.issues).toEqual([{ message: "Expected a port", path: [{ key: "port" }] }]);
    for (const read of [readIssue, readMessage, readPath, readSegment, readKey])
      expect(read).toHaveBeenCalledOnce();
    expect(metadata).not.toHaveBeenCalled();
    const capturedIssue = failure.issues[0]!;
    expect(Object.isFrozen(failure.issues)).toBe(true);
    expect(Object.isFrozen(capturedIssue)).toBe(true);
    expect(Object.isFrozen(capturedIssue.path)).toBe(true);
    expect(Object.isFrozen(capturedIssue.path?.[0])).toBe(true);
    expect(Reflect.ownKeys(failure.issues)).toEqual(["0", "length"]);
    expect(Reflect.ownKeys(capturedIssue.path!)).toEqual(["0", "length"]);
  });

  it("rejects sparse or malformed validation arrays", () => {
    expect(() => new ConfigurationValidationError(Array(1))).toThrow(/dense array/);
    expect(
      () => new ConfigurationValidationError([{ message: "Missing field", path: Array(1) }]),
    ).toThrow(/dense array/);
    const issues = new Proxy([], {
      get(target, key, receiver) {
        return key === "length" ? Infinity : Reflect.get(target, key, receiver);
      },
    });
    expect(() => new ConfigurationValidationError(issues)).toThrow(/array length/);
  });

  it("captures validation array indices before protocol accessors can replace later elements", () => {
    const path: Array<PropertyKey | StandardSchemaV1.PathSegment> = [
      {
        get key() {
          path[1] = "replaced";
          return "first";
        },
      },
      "second",
    ];
    const issues: StandardSchemaV1.Issue[] = [
      {
        get message() {
          issues[1] = { message: "Replaced" };
          return "First issue";
        },
        path,
      },
      { message: "Second issue" },
    ];

    const failure = new ConfigurationValidationError(issues);

    expect(failure.issues).toEqual([
      { message: "First issue", path: [{ key: "first" }, "second"] },
      { message: "Second issue" },
    ]);
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
