// Snapshot the container before passing its elements to code with access to internal records.
export function captureDataArray<T>(input: ReadonlyArray<T>, label: string): ReadonlyArray<T>;
export function captureDataArray(input: unknown, label: string): ReadonlyArray<unknown>;
export function captureDataArray(input: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  const keys = Reflect.ownKeys(input);
  const count = keys.length - 1;
  if (count !== Reflect.getOwnPropertyDescriptor(input, "length")?.value)
    throw new TypeError(`${label} must be a dense array`);
  const elements: unknown[] = [];
  for (const key of keys) {
    if (key === "length") continue;
    const index = typeof key === "string" ? Number(key) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= count || String(index) !== key)
      throw new TypeError(`${label} must contain only dense array indices`);
    const field = Reflect.getOwnPropertyDescriptor(input, key);
    if (!field || !("value" in field)) throw new TypeError(`${label} must contain data properties`);
    elements[index] = field.value;
  }
  return Object.freeze(elements);
}
