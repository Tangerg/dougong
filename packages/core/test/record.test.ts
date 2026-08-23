import { describe, expect, it } from "vitest";
import { assertPlainRecord } from "../src";

describe("assertPlainRecord", () => {
  it("uses TypeError for ordinary caller mistakes", () => {
    expect(() => assertPlainRecord([], "Options")).toThrowError(
      new TypeError("Options must be a plain record"),
    );
  });

  it("lets a higher layer preserve its public error taxonomy", () => {
    class BoundaryError extends Error {}

    expect(() =>
      assertPlainRecord({ unexpected: true }, "Options", {
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

    expect(() => assertPlainRecord(options, "Options")).toThrowError(
      new TypeError("Options field 'value' must be a data property"),
    );
    expect(accessed).toBe(false);
  });
});
