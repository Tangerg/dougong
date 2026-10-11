import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError } from "./errors";

// Validator results are untrusted. The envelope separates async validation from Promise-shaped config values.
export async function resolvePluginConfig(
  schema: StandardSchemaV1<unknown, unknown> | undefined,
  input: unknown,
  installationId: string,
): Promise<{ readonly value: unknown }> {
  if (!schema) return { value: input };
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
    throw new ConfigValidationError(issues as ReadonlyArray<StandardSchemaV1.Issue>);
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError(
      `Installation '${installationId}' config validator returned neither value nor issues`,
    );
  }
  return { value: (result as { readonly value: unknown }).value };
}
