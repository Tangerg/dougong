import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError } from "./errors";

/** Resolves one Plugin config at the Standard Schema trust boundary. */
export async function resolvePluginConfig(
  schema: StandardSchemaV1<unknown, unknown> | undefined,
  input: unknown,
  installationId: string,
) {
  if (!schema) return input;
  const result: unknown = await schema["~standard"].validate(input);
  if (!result || typeof result !== "object") {
    throw new TypeError(
      `Installation '${installationId}' config validator returned a non-object result`,
    );
  }

  const issues = Object.hasOwn(result, "issues")
    ? (result as { readonly issues?: unknown }).issues
    : undefined;
  if (issues !== undefined) {
    if (!Array.isArray(issues)) {
      throw new TypeError(
        `Installation '${installationId}' config validator returned non-array issues`,
      );
    }
    // ConfigValidationError is the canonical normalization boundary for the
    // structural Standard Schema issue protocol.
    throw new ConfigValidationError(issues as ReadonlyArray<StandardSchemaV1.Issue>);
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError(
      `Installation '${installationId}' config validator returned neither value nor issues`,
    );
  }
  return (result as { readonly value: unknown }).value;
}
