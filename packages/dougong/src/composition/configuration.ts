import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError } from "../contracts/errors.js";

export type ConfigValue =
  | null
  | boolean
  | string
  | number
  | ReadonlyArray<ConfigValue>
  | { readonly [key: string]: ConfigValue };

// Capturing a defined value domain prevents validators or callers from mutating an approved plan.
export function captureConfig(input: unknown): ConfigValue | undefined {
  const ancestors = new Set<object>();
  const copy = (value: unknown, path: string): ConfigValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null)
      throw new TypeError(`Unsupported config value at ${path}`);
    if (ancestors.has(value)) throw new TypeError(`Circular config at ${path}`);
    if (ancestors.size >= 64) throw new TypeError("Config exceeds the supported nesting depth");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1)
          throw new TypeError(`Config array must be dense at ${path}`);
        return Object.freeze(
          Array.from({ length: value.length }, (_, index) => {
            const field = Object.getOwnPropertyDescriptor(value, String(index));
            if (!field || !("value" in field))
              throw new TypeError(`Config must contain data properties at ${path}`);
            return copy(field.value, `${path}[${index}]`);
          }),
        );
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`Config must contain plain records at ${path}`);
      const result: Record<string, ConfigValue> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError(`Config keys must be strings at ${path}`);
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in field) || !field.enumerable)
          throw new TypeError(`Config must contain enumerable data properties at ${path}.${key}`);
        if (field.value !== undefined) result[key] = copy(field.value, `${path}.${key}`);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };
  return input === undefined ? undefined : copy(input, "config");
}

// Validator results are untrusted. The envelope separates async validation from Promise-shaped config values.
export async function resolvePluginConfig(
  schema: StandardSchemaV1<unknown, unknown> | undefined,
  input: unknown,
  installationId: string,
): Promise<{ readonly value: ConfigValue | undefined }> {
  const captured = captureConfig(input);
  if (!schema) return Object.freeze({ value: captured });
  const result: unknown = await schema["~standard"].validate(captured);
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
    throw new ConfigValidationError(issues as ReadonlyArray<StandardSchemaV1.Issue>, {
      details: { installation: installationId, phase: "configuration", outcome: "rejected" },
    });
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError(
      `Installation '${installationId}' config validator returned neither value nor issues`,
    );
  }
  return Object.freeze({ value: captureConfig((result as { readonly value: unknown }).value) });
}
