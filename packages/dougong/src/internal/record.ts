interface PlainRecordOptions {
  readonly fields?: ReadonlySet<string>;
  readonly createError?: (message: string) => Error;
}

const objectConstructorSource = Function.prototype.toString.call(Object);

function hasPlainPrototype(value: object): boolean {
  const prototype: object | null = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  // A foreign realm has its own intrinsic Object. A borrowed constructor does not authenticate a custom prototype.
  const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    Function.prototype.toString.call(constructor) === objectConstructorSource &&
    Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype
  );
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
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasPlainPrototype(value)) {
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
