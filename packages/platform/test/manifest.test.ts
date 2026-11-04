import { describe, expect, it, vi } from "vitest";
import { createHost } from "dougong";
import { z } from "zod";
import {
  createPlatform,
  defineManifest,
  ImportLoader,
  MemoryLoader,
  PermissionDeniedError,
  PermissionSet,
  PlatformError,
} from "../src";

import { emptyPlugin, fixture, select } from "./fixtures";

describe("manifest declarations", () => {
  it("captures and freezes every declared collection", () => {
    const input = {
      name: "capture",
      version: "1.0.0",
      activation: ["open"],
      permissions: ["read"],
      dependencies: { dependency: "^1.0.0" },
    };
    const manifest = defineManifest(input);
    input.activation.push("later");
    input.permissions[0] = "write";
    input.dependencies.dependency = "*";
    expect(manifest).toEqual({
      name: "capture",
      version: "1.0.0",
      apiVersion: "*",
      activation: ["open"],
      permissions: ["read"],
      dependencies: { dependency: "^1.0.0" },
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.activation)).toBe(true);
    expect(Object.isFrozen(manifest.dependencies)).toBe(true);
  });

  it("normalizes defaults without accepting undeclared fields", () => {
    expect(defineManifest({ name: "defaults", version: "1.0.0" }).activation).toEqual(["startup"]);
    expect(() =>
      defineManifest({ name: "defaults", version: "1.0.0", extra: true } as never),
    ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it.each(["", " name", "name "])("rejects malformed identifiers %j", (name) => {
    expect(() => defineManifest({ name, version: "1.0.0" })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
  });

  it.each(["1", "1.2", "1.2.x", "*", "01.2.3", " 1.2.3", "1.2.3 "])(
    "rejects non-concrete release versions %j",
    (version) => {
      expect(() => defineManifest({ name: "version", version })).toThrow(
        expect.objectContaining({ code: "MANIFEST_INVALID" }),
      );
      expect(() =>
        createPlatform({
          id: "version",
          host: createHost(),
          apiVersion: version,
          loader: new MemoryLoader(new Map()),
        }),
      ).toThrow("semantic version");
    },
  );

  it.each(["broken", "0.0.0 || broken", "^1.0.0 || >=2.0.0 broken", "1.x.2", "1.*.2"])(
    "checks every semver branch %j",
    (range) => {
      expect(() => defineManifest({ name: "range", version: "1.0.0", apiVersion: range })).toThrow(
        expect.objectContaining({ code: "MANIFEST_INVALID" }),
      );
      expect(() =>
        defineManifest({ name: "range", version: "1.0.0", dependencies: { dependency: range } }),
      ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
    },
  );

  it.each(["activation", "permissions"] as const)("rejects duplicate %s entries", (field) => {
    expect(() =>
      defineManifest({ name: "duplicate", version: "1.0.0", [field]: ["same", "same"] }),
    ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it("preserves prototype-named dependency edges from discovery through activation", async () => {
    const dependencies = { ["__proto__"]: "^1.0.0", constructor: "*", toString: "*" };
    const input = { name: "consumer", version: "1.0.0", dependencies };
    const manifest = defineManifest(input);
    expect(Object.keys(manifest.dependencies)).toEqual(Object.keys(dependencies));
    expect(Object.getPrototypeOf(manifest.dependencies)).toBe(Object.prototype);
    expect(() => defineManifest({ ...input, dependencies: { ["__proto__"]: "broken" } })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );

    const modules = new Map(
      ["consumer", ...Object.keys(dependencies)].map((name) => [name, emptyPlugin(name)]),
    );
    const { platform } = fixture(modules);
    const root = await select(platform, "consumer", "consumer", manifest);
    expect(
      platform.preview([root]).blockers.map((blocker) => blocker.dependencyPath.at(-1)),
    ).toEqual(Object.keys(dependencies));
    for (const name of Object.keys(dependencies)) await select(platform, name, name);
    await platform.activate([root]);
    expect(root.activeOrigin?.manifest.dependencies).toEqual(manifest.dependencies);
    await platform[Symbol.asyncDispose]();
  });

  it("does not invoke top-level declaration accessors", () => {
    const getter = vi.fn<() => string>(() => "name");
    const input = Object.defineProperty({ version: "1.0.0" }, "name", {
      enumerable: true,
      get: getter,
    });
    expect(() => defineManifest(input as never)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves reflection failure provenance without trusting an external code", () => {
    const reason = new PlatformError("MANIFEST_INVALID", "external");
    const input = new Proxy(
      { name: "reflection", version: "1.0.0" },
      {
        getPrototypeOf() {
          throw reason;
        },
      },
    );
    expect(() => defineManifest(input)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID", cause: reason }),
    );
  });

  it("attributes a replayed validation error to the supplier that threw it", () => {
    let previous: unknown;
    try {
      defineManifest({ name: "old", version: "1.0.0", dependencies: [] } as never);
    } catch (error) {
      previous = error;
    }
    expect(previous).toBeInstanceOf(PlatformError);
    const unreadable = new Proxy(
      { name: "new", version: "1.0.0" },
      {
        ownKeys() {
          throw previous;
        },
      },
    );
    expect(() => defineManifest(unreadable)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID", cause: previous }),
    );
  });

  it("captures inaccessible rejection values without inspecting them", () => {
    const reason = Proxy.revocable({}, {});
    reason.revoke();
    const input = new Proxy(
      { name: "reflection", version: "1.0.0" },
      {
        getPrototypeOf() {
          throw reason.proxy;
        },
      },
    );
    let failure: unknown;
    try {
      defineManifest(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PlatformError);
    expect(Object.is((failure as Error).cause, reason.proxy)).toBe(true);
  });

  it("makes owned declaration errors immutable", () => {
    let failure: unknown;
    try {
      defineManifest({ name: "invalid", version: "1.0.0", dependencies: [] } as never);
    } catch (error) {
      failure = error;
    }
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Reflect.set(failure as object, "code", "MODULE_INVALID")).toBe(false);
  });

  it("preserves an unexpected collection validation failure under the manifest boundary", () => {
    const cause = new Error("unreadable activation events");
    const activation = new Proxy(["startup"], {
      ownKeys() {
        throw cause;
      },
    });
    expect(() => defineManifest({ name: "invalid", version: "1.0.0", activation })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID", cause }),
    );
  });

  it("contains field reflection failures during validation error materialization", () => {
    const cause = new Error("unreadable manifest name");
    const name = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw cause;
        },
      },
    );
    expect(() => defineManifest({ name, version: "1.0.0" } as never)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID", cause }),
    );
  });

  it.each(["customError", "localeError"] as const)(
    "contains lazy %s failures without trusting supplier error codes",
    (option) => {
      const previous = { ...z.config() };
      const cause = new PlatformError("MANIFEST_INVALID", "supplier formatter failed");
      try {
        z.config({
          [option]: () => {
            throw cause;
          },
        });
        expect(() => defineManifest({ name: 42, version: "1.0.0" } as never)).toThrow(
          expect.objectContaining({ code: "MANIFEST_INVALID", cause }),
        );
      } finally {
        z.config({ customError: undefined, localeError: undefined, ...previous });
      }
    },
  );

  it("preserves one materialized validator error as the cause of ordinary rejection", () => {
    const previous = { ...z.config() };
    const customError = vi.fn<() => string>(() => "manifest name must be a string");
    try {
      z.config({ customError });
      expect(() => defineManifest({ name: 42, version: "1.0.0" } as never)).toThrow(
        expect.objectContaining({
          code: "MANIFEST_INVALID",
          cause: expect.any(z.ZodError),
          message: expect.stringContaining("manifest name must be a string"),
        }),
      );
      expect(customError).toHaveBeenCalledTimes(1);
    } finally {
      z.config({ customError: undefined, ...previous });
    }
  });
});

describe("loaders and permission policy", () => {
  it("captures the MemoryLoader collection and rejects unknown references", () => {
    const modules = new Map([["one", { value: 1 }]]);
    const loader = new MemoryLoader(modules);
    modules.set("one", { value: 2 });
    const signal = new AbortController().signal;
    expect(loader.load("one", signal)).toEqual({ value: 1 });
    expect(() => loader.load("missing", signal)).toThrow("Unknown module");
    expect(() => new MemoryLoader({} as never)).toThrow("ReadonlyMap");
  });

  it("imports trusted ESM and honors cancellation before evaluating", async () => {
    const loader = new ImportLoader();
    const source = "data:text/javascript,export default 42";
    expect(
      ((await loader.load(source, new AbortController().signal)) as { default: number }).default,
    ).toBe(42);
    const controller = new AbortController();
    controller.abort();
    await expect(loader.load(source, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it("rejects identities that cannot be encoded in an Installation ID at declaration", () => {
    const invalid = "part-\ud800";
    expect(() => defineManifest({ name: invalid, version: "1.0.0" })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
    expect(() =>
      defineManifest({ name: "root", version: "1.0.0", dependencies: { [invalid]: "*" } }),
    ).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID" }));
    expect(() =>
      createPlatform({
        id: invalid,
        host: createHost(),
        apiVersion: "1.0.0",
        loader: new MemoryLoader(new Map()),
      }),
    ).toThrow(TypeError);
  });

  it("rejects a mutable URL without executing a supplied coercion method", async () => {
    const reference = new URL("data:text/javascript,export default 817");
    const substitute = vi.fn<() => string>(() => "data:text/javascript,export default 0");
    Object.defineProperty(reference, Symbol.toPrimitive, { value: substitute });
    const rejection = await new ImportLoader()
      .load(reference as never, new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(rejection).toBeInstanceOf(TypeError);
    expect(rejection).toMatchObject({ message: "ImportLoader reference must be a string" });
    expect(substitute).not.toHaveBeenCalled();
  });

  it("projects permission fields into Registration diagnostics", async () => {
    const { platform } = fixture();
    const registration = await select(platform, "reader", "reader", { permissions: ["disk:read"] });
    await expect(platform.activate([registration])).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(registration.error?.snapshot.fields).toEqual({
      manifestName: "reader",
      denied: ["disk:read"],
    });
    await platform[Symbol.asyncDispose]();
  });

  it("captures grants and exposes owned denied-permission data", () => {
    const grants = ["read"];
    const policy = new PermissionSet(grants);
    grants.push("write");
    const manifest = defineManifest({
      name: "permission",
      version: "1.0.0",
      permissions: ["read", "write"],
    });
    expect(() =>
      policy.authorize(
        { artifact: { revision: "r1", manifest }, operation: "load" },
        new AbortController().signal,
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED", denied: ["write"] }));
    const denied = ["read"];
    const error = new PermissionDeniedError("permission", denied);
    denied.push("write");
    expect(error.denied).toEqual(["read"]);
    expect(Object.isFrozen(error.denied)).toBe(true);
  });

  it.each([null, "read", [""], [" read"], [4]])(
    "rejects malformed permission grants %j",
    (value) => {
      expect(() => new PermissionSet(value as never)).toThrow(TypeError);
    },
  );

  it("validates public permission failures and cancellation", () => {
    expect(() => new PermissionDeniedError("", [])).toThrow(TypeError);
    expect(() => new PermissionDeniedError("valid", null as never)).toThrow(TypeError);
    expect(() => new PermissionDeniedError("valid", [" bad"])).toThrow(TypeError);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      new PermissionSet().authorize(
        {
          artifact: {
            revision: "1",
            manifest: defineManifest({ name: "permission", version: "1.0.0" }),
          },
          operation: "load",
        },
        controller.signal,
      ),
    ).toThrow(controller.signal.reason);
  });
});
