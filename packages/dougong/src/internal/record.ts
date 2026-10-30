interface PlainRecordOptions {
  readonly fields?: ReadonlySet<string>;
  readonly createError?: (message: string) => Error;
}

// Capture inert descriptors so accessors and Proxy reads cannot replace already-validated declaration values.
export function normalizePlainRecord<T extends object>(
  value: T,
  label: string,
  options?: PlainRecordOptions,
): Readonly<T>;
export function normalizePlainRecord(
  value: unknown,
  label: string,
  options?: PlainRecordOptions,
): Readonly<Record<string, unknown>>;
export function normalizePlainRecord(
  value: unknown,
  label: string,
  options: PlainRecordOptions = {},
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recordError(options, `${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw recordError(options, `${label} must be a plain record`);
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable) {
      throw recordError(options, `${label} keys must be enumerable strings`);
    }
    if (!("value" in descriptor)) {
      throw recordError(options, `${label} field '${key}' must be a data property`);
    }
    if (options.fields && !options.fields.has(key)) {
      throw recordError(options, `${label}: unknown field '${key}'`);
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function recordError(options: PlainRecordOptions, message: string) {
  return options.createError?.(message) ?? new TypeError(message);
}
