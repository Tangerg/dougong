import { isError, RecordedFailure } from "dougong";
import type { PermissionDeniedError } from "../admission/permissions.js";
import { PlatformError, activationFailedCode } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

const diagnosticFields = Object.freeze([
  "manifestName",
  "denied",
] satisfies (keyof PermissionDeniedError)[]);

// Only selections this attempt tried to change record the failure; reused Artifacts did not fail.
export function recordActivationFailure<Reference>(
  plan: ActivationPlan<Reference>,
  error: unknown,
) {
  const failure = isError(error)
    ? error
    : new PlatformError(activationFailedCode, "Activation failed with a non-Error value", {
        cause: error,
      });
  let recorded: RecordedFailure | undefined;
  for (const selection of plan.selections) {
    if (selection.registration.actionFor(selection.artifact) !== "reuse") {
      selection.registration.fail(
        selection.revision,
        (recorded ??= new RecordedFailure(failure, diagnosticFields)),
      );
    }
  }
  return failure;
}
