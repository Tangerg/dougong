import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ConfigValidationError } from "../contracts/errors.js";

export type ConfigValue =
  | null
  | boolean
  | string
  | number
  | ReadonlyArray<ConfigValue>
  | { readonly [key: string]: ConfigValue };

const maxConfigDepth = 64;

interface CapturedValue {
  readonly value: ConfigValue;
  readonly height: number;
}

export function captureConfig(input: unknown): ConfigValue | undefined {
  const ancestors = new Set<object>();
  const captured = new Map<object, CapturedValue>();
  const visit = (value: unknown, path: string): CapturedValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return { value, height: 0 };
    if (typeof value === "number" && Number.isFinite(value)) return { value, height: 0 };
    if (typeof value !== "object" || value === null)
      throw new TypeError(`Unsupported config value at ${path}`);
    if (ancestors.has(value)) throw new TypeError(`Circular config at ${path}`);
    // Shared input is read once; its cached height must still fit every path that reuses it.
    const known = captured.get(value);
    if (ancestors.size + (known?.height ?? 1) > maxConfigDepth)
      throw new TypeError("Config exceeds the supported nesting depth");
    if (known) return known;
    ancestors.add(value);
    let height = 1;
    const member = (raw: unknown, memberPath: string) => {
      const child = visit(raw, memberPath);
      height = Math.max(height, child.height + 1);
      return child.value;
    };
    let result: ConfigValue;
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (keys.length - 1 !== length) throw new TypeError(`Config array must be dense at ${path}`);
      const items: ConfigValue[] = [];
      for (const key of keys) {
        if (key === "length") continue;
        const index = typeof key === "string" ? Number(key) : NaN;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= keys.length - 1 ||
          String(index) !== key
        )
          throw new TypeError(`Config array must be dense at ${path}`);
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !("value" in field))
          throw new TypeError(`Config must contain data properties at ${path}`);
        items[index] = member(field.value, `${path}[${index}]`);
      }
      result = Object.freeze(items);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`Config must contain plain records at ${path}`);
      const record: Record<string, ConfigValue> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError(`Config keys must be strings at ${path}`);
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !("value" in field) || !field.enumerable)
          throw new TypeError(`Config must contain enumerable data properties at ${path}.${key}`);
        if (field.value !== undefined) record[key] = member(field.value, `${path}.${key}`);
      }
      result = Object.freeze(record);
    }
    ancestors.delete(value);
    const entry = { value: result, height };
    captured.set(value, entry);
    return entry;
  };
  return input === undefined ? undefined : visit(input, "config").value;
}

// Validator results are untrusted. The envelope separates async validation from Promise-shaped config values.
export async function resolvePluginConfig(
  schema: StandardSchemaV1<unknown, unknown> | undefined,
  input: ConfigValue | undefined,
  installationId: string,
): Promise<{ readonly value: ConfigValue | undefined }> {
  if (!schema) return Object.freeze({ value: input });
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
    throw new ConfigValidationError(issues as ReadonlyArray<StandardSchemaV1.Issue>, {
      details: { installation: installationId, phase: "configuration", outcome: "rejected" },
    });
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError(
      `Installation '${installationId}' config validator returned neither value nor issues`,
    );
  }
  const output = (result as { readonly value: unknown }).value;
  return Object.freeze({ value: Object.is(output, input) ? input : captureConfig(output) });
}
