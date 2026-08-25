interface PlainRecordOptions {
  /** When present, any key outside this set is rejected instead of ignored. */
  readonly fields?: ReadonlySet<string>;
  /** Lets a caller raise its own coded error instead of a bare `TypeError`. */
  readonly createError?: (message: string) => Error;
}

/**
 * Validates declaration bags without reading through their prototype chain.
 *
 * Every option object Core accepts passes through here. The checks look
 * paranoid, and each one closes a way for a declaration to lie:
 *
 * - a non-`Object.prototype` prototype could answer for keys it does not own;
 * - a non-enumerable or symbol key would escape the field allowlist;
 * - a getter (`{ get name() {...} }`) would return a different value on the
 *   second read, so validation would not describe what gets stored.
 *
 * Rejecting an unknown field rather than ignoring it turns a typo — `permissions`
 * for `authorizer` — into an error at the call site instead of silence.
 */
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
  }
}

function recordError(options: PlainRecordOptions, message: string) {
  return options.createError?.(message) ?? new TypeError(message);
}
