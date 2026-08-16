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
});
