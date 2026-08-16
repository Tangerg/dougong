import { describe, expect, it } from "vitest";
import { assertPromiseRuntime, resolveDisposalSymbol } from "../src/resource";

describe("resource runtime", () => {
  it("fails explicitly when Promise.withResolvers is unavailable", () => {
    expect(() => assertPromiseRuntime(undefined)).toThrow(
      "Unsupported JavaScript runtime: Promise.withResolvers is required",
    );
  });

  it("uses stable disposal protocol keys when the runtime lacks the well-known symbols", () => {
    expect(resolveDisposalSymbol(undefined, "Symbol.dispose")).toBe(Symbol.for("Symbol.dispose"));
    expect(resolveDisposalSymbol(undefined, "Symbol.asyncDispose")).toBe(
      Symbol.for("Symbol.asyncDispose"),
    );
  });
});
