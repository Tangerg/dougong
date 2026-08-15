import { describe, expect, it } from "vitest";
import { ReadonlyMapSnapshot } from "../src/index";

describe("ReadonlyMapSnapshot", () => {
  it("rejects values that the public type does not admit", () => {
    expect(() => new ReadonlyMapSnapshot(null as never)).toThrowError(
      new TypeError("ReadonlyMapSnapshot values must be an iterable object"),
    );
    expect(() => new ReadonlyMapSnapshot("entry" as never)).toThrowError(
      new TypeError("ReadonlyMapSnapshot values must be an iterable object"),
    );
  });
});
