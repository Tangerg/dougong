import { describe, expect, it } from "vitest";
import { normalizePlainRecord } from "../src";

describe("normalizePlainRecord", () => {
  it("uses TypeError for ordinary caller mistakes", () => {
    expect(() => normalizePlainRecord([], "Options")).toThrowError(
      new TypeError("Options must be a plain record"),
    );
  });

  it("lets a higher layer preserve its public error taxonomy", () => {
    class BoundaryError extends Error {}

    expect(() =>
      normalizePlainRecord({ unexpected: true }, "Options", {
        fields: new Set(["expected"]),
        createError: (message) => new BoundaryError(message),
      }),
    ).toThrowError(new BoundaryError("Options: unknown field 'unexpected'"));
  });

  it("keeps declaration records inert by rejecting accessors without invoking them", () => {
    let accessed = false;
    const options = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        accessed = true;
        return 1;
      },
    });

    expect(() => normalizePlainRecord(options, "Options")).toThrowError(
      new TypeError("Options field 'value' must be a data property"),
    );
    expect(accessed).toBe(false);
  });

  it("owns the captured fields while leaving opaque values with their callers", () => {
    const payload = { current: 1 };
    const input = { name: "original", payload };
    const declaration = normalizePlainRecord(input, "Options");
    input.name = "replacement";

    expect(declaration.name).toBe("original");
    expect(declaration.payload).toBe(payload);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.getPrototypeOf(declaration)).toBeNull();
  });

  it("captures each descriptor once and preserves special own keys as data", () => {
    const input = Object.fromEntries([["__proto__", "data"]]);
    let reads = 0;
    const declaration = normalizePlainRecord(
      new Proxy(input, {
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get() {
          throw new Error("Ordinary property reads are not declaration capture");
        },
      }),
      "Options",
    );

    expect(reads).toBe(1);
    expect(Object.hasOwn(declaration, "__proto__")).toBe(true);
    expect(declaration.__proto__).toBe("data");
    expect(Object.getPrototypeOf(declaration)).toBeNull();
  });
});
