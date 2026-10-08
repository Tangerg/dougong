import { describe, expect, it, vi } from "vitest";
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

function configProbe(source: "input" | "schema", value: unknown) {
  const setup = vi.fn<(_context: unknown, _config: unknown) => undefined>(() => undefined);
  const plugin = definePlugin<unknown>({
    name: "test.opaque-config",
    ...(source === "schema" ? { config: schemaReturning(Promise.resolve({ value })) } : {}),
    setup,
  });
  const host = createHost();
  const installation = host.install(plugin, source === "schema" ? "validator input" : value);
  return { host, installation, setup };
}

describe("Plugin config validation", () => {
  it.each(["input", "schema"] as const)(
    "preserves a Promise-valued config from %s through activation and update",
    async (source) => {
      const value = Promise.resolve(7);
      const { host, installation, setup } = configProbe(source, value);
      try {
        await host.start();
        await installation.update({ config: source === "schema" ? "next input" : value });
        expect(setup).toHaveBeenCalledTimes(2);
        for (const call of setup.mock.calls) expect(call[1]).toBe(value);
      } finally {
        await host.stop();
      }
    },
  );

  it.each(["input", "schema"] as const)(
    "does not read or invoke a config's then protocol from %s",
    async (source) => {
      const then = vi.fn<(resolve: (value: number) => void) => void>((resolve) => resolve(7));
      const readThen = vi.fn<() => typeof then>(() => then);
      const value = new Proxy(
        {},
        {
          get(target, key, receiver) {
            if (key === "then") return readThen();
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const { host, setup } = configProbe(source, value);
      try {
        await host.start();
        expect(setup.mock.calls[0]?.[1]).toBe(value);
        expect(readThen).not.toHaveBeenCalled();
        expect(then).not.toHaveBeenCalled();
      } finally {
        await host.stop();
      }
    },
  );

  it.each(["input", "schema"] as const)(
    "does not wait for a pending config Promise from %s",
    async (source) => {
      const pending = Promise.withResolvers<number>();
      const { host, setup } = configProbe(source, pending.promise);
      const starting = host.start();
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const callsBeforeResolution = setup.mock.calls.length;
        pending.resolve(7);
        await starting;
        expect(callsBeforeResolution).toBe(1);
        expect(setup.mock.calls[0]?.[1]).toBe(pending.promise);
      } finally {
        pending.resolve(7);
        await starting;
        await host.stop();
      }
    },
  );

  it.each(["input", "schema"] as const)(
    "leaves rejection observation of a config Promise from %s to its consumer",
    async (source) => {
      const value = Promise.reject(new Error("config resource unavailable"));
      void value.catch(() => undefined);
      const { host, setup } = configProbe(source, value);
      try {
        await host.start();
        expect(setup.mock.calls[0]?.[1]).toBe(value);
      } finally {
        await host.stop();
      }
    },
  );

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
