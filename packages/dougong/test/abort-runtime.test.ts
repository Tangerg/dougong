import { expect, it } from "vitest";
import { assertAbortRuntime } from "#abort-listener";

it("admits a runtime whose composite signals read native state", () => {
  expect(() => assertAbortRuntime(AbortSignal.any)).not.toThrow();
});

it("refuses a runtime without signal composition", () => {
  expect(() => assertAbortRuntime(undefined)).toThrow(
    "Unsupported JavaScript runtime: AbortSignal.any is required",
  );
});

it("refuses composition that trusts shadowed signal properties", () => {
  function shadowTrustingAny(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) if (signal.aborted) controller.abort(signal.reason);
    return controller.signal;
  }
  expect(() => assertAbortRuntime(shadowTrustingAny)).toThrow(
    "Unsupported JavaScript runtime: AbortSignal.any must read native signal state",
  );
});
