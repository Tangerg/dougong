interface PlainRecordOptions {
  readonly fields?: ReadonlySet<string>;
  readonly createError?: (message: string) => Error;
}

/** Validates declaration bags without reading through their prototype chain. */
export function assertPlainRecord(
  value: unknown,
  label: string,
  options: PlainRecordOptions = {},
): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recordError(options, `${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw recordError(options, `${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw recordError(options, `${label} keys must be enumerable strings`);
    }
    if (options.fields && !options.fields.has(key)) {
      throw recordError(options, `${label}: unknown field '${key}'`);
    }
  }
}

function recordError(options: PlainRecordOptions, message: string) {
  return options.createError?.(message) ?? new TypeError(message);
}
