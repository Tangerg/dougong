import { describe, expect, it } from "vitest";
import { ReadonlyMapSnapshot } from "../src/advanced";

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

it("consumes the iterable's own iterator exactly once and validates empty-map callbacks", () => {
  const entries = new Map([["first", 1]]);
  let reads = 0;
  const input = {
    get [Symbol.iterator]() {
      if (++reads !== 1) throw new Error("iterator read twice");
      return entries[Symbol.iterator].bind(entries);
    },
  };
  expect([...new ReadonlyMapSnapshot(input)]).toEqual([["first", 1]]);
  expect(() => new ReadonlyMapSnapshot().forEach(null as never)).toThrow(TypeError);
});
