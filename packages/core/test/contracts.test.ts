import { describe, expect, it } from "vitest";
import { assertContract, event, extensionPoint, service } from "../src/contracts";

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
