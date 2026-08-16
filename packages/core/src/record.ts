interface PlainRecordOptions {
  readonly fields?: ReadonlySet<string>;
}

/** Validates declaration and options bags without reading through their prototype chain. */
export function assertPlainRecord(
  value: unknown,
  label: string,
  options: PlainRecordOptions = {},
): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new TypeError(`${label} keys must be enumerable strings`);
    }
    if (options.fields && !options.fields.has(key)) {
      throw new TypeError(`${label}: unknown field '${key}'`);
    }
  }
}
