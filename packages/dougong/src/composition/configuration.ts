import type { StandardSchemaV1 } from "@standard-schema/spec";
import { onAbort } from "../internal/abort.js";
import { captureDataArray } from "../internal/data-array.js";
import { ConfigurationValidationError } from "../contracts/errors.js";

export type ConfigurationValue =
  | null
  | boolean
  | string
  | number
  | ReadonlyArray<ConfigurationValue>
  | { readonly [key: string]: ConfigurationValue };

const maximumConfigurationDepth = 64;

interface CapturedValue {
  readonly value: ConfigurationValue;
  readonly height: number;
}

export function captureConfiguration(input: unknown): ConfigurationValue | undefined {
  const ancestors = new Set<object>();
  const captured = new Map<object, CapturedValue>();
  const visit = (value: unknown, path: string): CapturedValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return { value, height: 0 };
    if (typeof value === "number" && Number.isFinite(value)) return { value, height: 0 };
    if (typeof value !== "object" || value === null)
      throw new TypeError(`Unsupported configuration value at ${path}`);
    if (ancestors.has(value)) throw new TypeError(`Circular configuration at ${path}`);
    // Shared input is read once; its cached height must still fit every path that reuses it.
    const known = captured.get(value);
    if (ancestors.size + (known?.height ?? 1) > maximumConfigurationDepth)
      throw new TypeError("Configuration exceeds the supported nesting depth");
    if (known) return known;
    ancestors.add(value);
    let height = 1;
    const member = (raw: unknown, memberPath: string) => {
      const child = visit(raw, memberPath);
      height = Math.max(height, child.height + 1);
      return child.value;
    };
    let result: ConfigurationValue;
    if (Array.isArray(value)) {
      const items = captureDataArray(value, `Configuration array at ${path}`);
      result = Object.freeze(items.map((item, index) => member(item, `${path}[${index}]`)));
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`Configuration must contain plain records at ${path}`);
      const record: Record<string, ConfigurationValue> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string")
          throw new TypeError(`Configuration keys must be strings at ${path}`);
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !("value" in field) || !field.enumerable)
          throw new TypeError(
            `Configuration must contain enumerable data properties at ${path}.${key}`,
          );
        if (field.value !== undefined) record[key] = member(field.value, `${path}.${key}`);
      }
      result = Object.freeze(record);
    }
    ancestors.delete(value);
    const entry = { value: result, height };
    captured.set(value, entry);
    return entry;
  };
  return input === undefined ? undefined : visit(input, "configuration").value;
}

// Validator results are untrusted. The envelope separates async validation from Promise-shaped configuration values.
export async function resolvePluginConfiguration(
  schema: StandardSchemaV1<unknown, unknown> | undefined,
  input: ConfigurationValue | undefined,
  installationId: string,
  validity?: AbortSignal,
): Promise<{ readonly value: ConfigurationValue | undefined }> {
  validity?.throwIfAborted();
  if (!schema) return Object.freeze({ value: input });
  const response = schema["~standard"].validate(input);
  const result: unknown = validity
    ? (await readWhileCurrent(response, validity)).result
    : await response;
  validity?.throwIfAborted();
  if (!result || typeof result !== "object") {
    throw new TypeError(
      `Installation '${installationId}' configuration validator returned a non-object result`,
    );
  }

  const issues = Object.hasOwn(result, "issues")
    ? (result as { readonly issues?: unknown }).issues
    : undefined;
  if (issues !== undefined) {
    if (!Array.isArray(issues)) {
      throw new TypeError(
        `Installation '${installationId}' configuration validator returned non-array issues`,
      );
    }
    throw new ConfigurationValidationError(issues as ReadonlyArray<StandardSchemaV1.Issue>, {
      details: { installation: installationId, phase: "configuration", outcome: "rejected" },
    });
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError(
      `Installation '${installationId}' configuration validator returned neither value nor issues`,
    );
  }
  const output = (result as { readonly value: unknown }).value;
  return Object.freeze({ value: Object.is(output, input) ? input : captureConfiguration(output) });
}

// Losing a revision detaches this plan; a non-cooperative validator may finish on its own.
// Box its result so the race cannot repeat thenable assimilation on an application value.
function readWhileCurrent(response: unknown, validity: AbortSignal) {
  let waiting: PromiseWithResolvers<{ result: unknown }> | undefined = Promise.withResolvers<{
    result: unknown;
  }>();
  const { promise } = waiting;
  const detach = onAbort(validity, (reason) => {
    waiting?.reject(reason);
    waiting = undefined;
  });
  void boxValidationResult(response).then(
    (result) => waiting?.resolve(result),
    (error) => waiting?.reject(error),
  );
  return promise.finally(() => {
    waiting = undefined;
    detach();
  });
}

async function boxValidationResult(response: unknown) {
  return { result: await response };
}
