// Identities compare by exact string, so surrounding whitespace would create look-alike identities.
export function isTrimmedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function assertTrimmedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${label} must be a non-empty string`);
  if (value !== value.trim()) throw new TypeError(`${label} cannot start or end with whitespace`);
}
