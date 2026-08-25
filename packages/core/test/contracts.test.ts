import { describe, expect, it } from "vitest";
import { assertContract, event, extensionPoint, optional, service } from "../src/contracts";

describe("Contract identity", () => {
  // A Contract id is a namespaced key that outlives the code declaring it, so a
  // blank or padded one is rejected at the factory. Accepting `" app/theme "`
  // would create a second, invisible identity that never matches the intended
  // one and cannot be spotted by reading either declaration.
  it.each([
    ["service", service],
    ["event", event],
    ["extensionPoint", extensionPoint],
  ] as const)("rejects a blank %s id", (_kind, factory) => {
    expect(() => factory("")).toThrowError(new TypeError("Contract id must be a non-empty string"));
    expect(() => factory("   ")).toThrowError(
      new TypeError("Contract id must be a non-empty string"),
    );
    expect(() => factory(undefined as never)).toThrowError(
      new TypeError("Contract id must be a non-empty string"),
    );
  });

  it.each([
    ["service", service],
    ["event", event],
    ["extensionPoint", extensionPoint],
  ] as const)("rejects a padded %s id rather than trimming it", (_kind, factory) => {
    expect(() => factory(" app/theme ")).toThrowError(
      new TypeError("Contract id cannot start or end with whitespace"),
    );
  });

  it("freezes tokens so an id or kind cannot be repointed after declaration", () => {
    const token = service<string>("contract/frozen");

    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.keys(token)).toEqual(["id", "kind"]);
  });

  it("wraps rather than flags, so the optional form is a distinct value", () => {
    const token = service<string>("contract/optional-wrap");
    const relaxed = optional(token);

    expect(relaxed).not.toBe(token);
    expect(relaxed.service).toBe(token);
    expect(token.kind).toBe("service");
    expect(() => optional(event("contract/not-a-service") as never)).toThrowError(
      new TypeError("optional() expects a Service"),
    );
  });
});

describe("Contract validation", () => {
  it.each([
    ["service", event("contract/not-service"), "Expected a Service"],
    ["extensionPoint", service("contract/not-point"), "Expected an ExtensionPoint"],
    ["event", extensionPoint("contract/not-event"), "Expected an Event"],
  ] as const)("describes an expected %s precisely", (kind, value, message) => {
    expect(() => assertContract(value, kind)).toThrowError(new TypeError(message));
  });

  it("distinguishes an invalid Contract from a kind mismatch", () => {
    expect(() => assertContract(null)).toThrowError(new TypeError("Invalid contract"));
  });
});
