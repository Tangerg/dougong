import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError } from "./errors";

/**
 * Resolves one Plugin config at the Standard Schema trust boundary.
 *
 * The validator is third-party code, so its return value is checked as
 * untrusted input rather than trusted to match the spec. A validator that
 * returns a string, or an object with neither `value` nor `issues`, is a bug in
 * that library — it becomes a `TypeError` naming the Installation rather than an
 * `undefined` config that fails somewhere inside `setup()`.
 *
 * A schema is optional. With none declared, the input passes through untouched:
 * Core does not invent a validation step the Plugin author did not ask for.
 */
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
