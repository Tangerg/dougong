import { captureDataArray } from "../internal/data-array.js";
import {
  detailKinds,
  isDetailRevision,
  isError,
  isPropertyKey,
  outcomes,
  ownDataField,
  readErrorProperty,
  type DetailField,
  type ErrorDetails,
} from "./errors.js";

const maximumDiagnosticFields = 8;
const maximumDiagnosticFieldNameLength = 256;
const maximumDiagnosticFieldTextLength = 256;
const maximumDiagnosticFieldItems = 8;
const maximumErrorDepth = 4;
const maximumRecordedErrors = 32;
const maximumErrorNameLength = 256;
const maximumErrorCodeLength = 256;
const maximumErrorMessageLength = 4096;
const maximumErrorStackLength = 16384;
const maximumAggregateErrors = 8;
const maximumValidationIssues = 8;
const maximumValidationPathSegments = 16;
const maximumValidationPathSegmentLength = 256;
const maximumErrorDetailTextLength = 256;
const maximumErrorDetailPathItems = 32;

const primitiveTypes = new Set(["string", "number", "boolean", "undefined", "bigint", "symbol"]);

export type ErrorSnapshot = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: ErrorSnapshot;
  readonly errors?: ReadonlyArray<ErrorSnapshot>;
  readonly details?: ErrorDetails;
  readonly fields?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly issues?: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
  }>;
  readonly truncated?: true;
} & (
  | { readonly error: ErrorSnapshot; readonly suppressed: ErrorSnapshot }
  | { readonly error?: never; readonly suppressed?: never }
);

const truncatedChain: ErrorSnapshot = Object.freeze({
  name: "TruncatedError",
  message: "Error chain truncated",
  truncated: true,
});

// Terminal diagnostics must not retain application resources through Error causes or custom fields.
export class RecordedFailure extends Error {
  override readonly name = "RecordedFailure";
  readonly code: string | undefined;
  readonly #snapshot: ErrorSnapshot;

  get snapshot() {
    return this.#snapshot;
  }

  static #recorded(value: unknown) {
    return value !== null && typeof value === "object" && #snapshot in value
      ? value.#snapshot
      : undefined;
  }

  constructor(error: unknown, fields: ReadonlyArray<string> = []) {
    const names = captureDataArray(fields, "Diagnostic field names");
    if (
      names.length > maximumDiagnosticFields ||
      names.some(
        (name) =>
          typeof name !== "string" || !name || name.length > maximumDiagnosticFieldNameLength,
      )
    ) {
      throw new TypeError(
        `Select at most ${maximumDiagnosticFields} diagnostic field names of 1–${maximumDiagnosticFieldNameLength} characters each`,
      );
    }
    const snapshot =
      RecordedFailure.#recorded(error) ??
      new FailureRecorder(RecordedFailure.#recorded, new Set(names)).record(error, 0, false);
    super(snapshot.message);
    this.code = snapshot.code;
    this.#snapshot = snapshot;
    // Replace even a missing stack so V8 constructor frames cannot retain the recorded application.
    this.stack = snapshot.stack ?? `${this.name}: ${snapshot.message}`;
    Object.freeze(this);
  }
}

// One recorder bounds a whole report: nested records share its depth, size and cycle budget.
class FailureRecorder {
  readonly #recorded: (value: unknown) => ErrorSnapshot | undefined;
  readonly #fieldNames: ReadonlySet<string>;
  readonly #seen = new Set<unknown>();
  #remaining = maximumRecordedErrors;

  constructor(
    recorded: (value: unknown) => ErrorSnapshot | undefined,
    fieldNames: ReadonlySet<string>,
  ) {
    this.#recorded = recorded;
    this.#fieldNames = fieldNames;
  }

  record(raw: unknown, depth: number, fromSnapshot: boolean): ErrorSnapshot {
    const sealed = fromSnapshot ? (raw as ErrorSnapshot) : this.#recorded(raw);
    const value = sealed ?? raw;
    if (depth > maximumErrorDepth || this.#remaining-- <= 0 || this.#seen.has(value))
      return truncatedChain;
    if (!sealed && !isError(value)) return nonErrorSnapshot(value);
    this.#seen.add(value);

    const reader = new BoundedReader(sealed?.truncated ?? false);
    const name = reader.string(value, "name", maximumErrorNameLength) ?? "Error";
    const message = reader.string(value, "message", maximumErrorMessageLength) ?? "";
    const stack = reader.string(value, "stack", maximumErrorStackLength);
    const code = reader.string(value, "code", maximumErrorCodeLength);
    const cause = readErrorProperty(value, "cause");
    const errors = reader.list(readErrorProperty(value, "errors"), maximumAggregateErrors);
    const fields = sealed ? sealed.fields : this.#selectFields(value, reader);
    const issues = readIssues(value, reader);
    const rawDetails = readErrorProperty(value, "details");
    const details =
      rawDetails !== null && typeof rawDetails === "object"
        ? projectDetails(rawDetails, reader)
        : undefined;
    const child = (nested: unknown) => this.record(nested, depth + 1, !!sealed);
    // Native and downlevel suppression store both failures as own data, even when a subclass renames the Error.
    const primary = ownDataField(value, "error");
    const suppressed = primary && ownDataField(value, "suppressed");
    const snapshot = {
      name,
      message,
      ...(code === undefined ? {} : { code }),
      ...(stack === undefined ? {} : { stack }),
      ...(cause === undefined ? {} : { cause: child(cause) }),
      ...(errors === undefined ? {} : { errors: Object.freeze(errors.map(child)) }),
      ...(fields === undefined ? {} : { fields }),
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details }),
      ...(reader.truncated ? { truncated: true as const } : {}),
    };
    return Object.freeze(
      primary && suppressed
        ? { ...snapshot, error: child(primary.value), suppressed: child(suppressed.value) }
        : snapshot,
    );
  }

  #selectFields(value: unknown, reader: BoundedReader) {
    if (!this.#fieldNames.size) return undefined;
    const entries: Array<[string, string | ReadonlyArray<string>]> = [];
    for (const key of this.#fieldNames) {
      const raw = ownDataField(value, key)?.value;
      const data =
        typeof raw === "string"
          ? reader.clip(raw, maximumDiagnosticFieldTextLength)
          : reader.strings(raw, maximumDiagnosticFieldItems, maximumDiagnosticFieldTextLength);
      if (data !== undefined) entries.push([key, data]);
    }
    return entries.length ? Object.freeze(Object.fromEntries(entries)) : undefined;
  }
}

// Each recorded error reads foreign data once and remembers whether any of it was clipped.
class BoundedReader {
  truncated: boolean;

  constructor(truncated: boolean) {
    this.truncated = truncated;
  }

  clip(text: string, limit: number) {
    if (text.length > limit) this.truncated = true;
    return text.slice(0, limit);
  }

  string(source: unknown, key: string, limit: number) {
    const raw = readErrorProperty(source, key);
    return typeof raw === "string" ? this.clip(raw, limit) : undefined;
  }

  list(raw: unknown, limit: number): unknown[] | undefined {
    if (!isRecordableArray(raw)) return undefined;
    const length = readErrorProperty(raw, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
    if (length > limit) this.truncated = true;
    return Array.from({ length: Math.min(length, limit) }, (_, index) =>
      readErrorProperty(raw, index),
    );
  }

  strings(raw: unknown, limit: number, itemLength: number): ReadonlyArray<string> | undefined {
    const items = this.list(raw, limit);
    return (
      items &&
      Object.freeze(
        items
          .filter((item): item is string => typeof item === "string")
          .map((item) => this.clip(item, itemLength)),
      )
    );
  }
}

function nonErrorSnapshot(value: unknown): ErrorSnapshot {
  const message =
    value === null || primitiveTypes.has(typeof value) ? String(value) : "Non-Error object omitted";
  return Object.freeze({
    name: "NonError",
    message: message.slice(0, maximumErrorMessageLength),
    ...(message.length > maximumErrorMessageLength ? { truncated: true as const } : {}),
  });
}

function readIssues(value: unknown, reader: BoundedReader) {
  const issues = reader.list(readErrorProperty(value, "issues"), maximumValidationIssues);
  if (!issues) return undefined;
  return Object.freeze(
    issues.map((issue) => {
      const message = readErrorProperty(issue, "message");
      const path = reader
        .list(readErrorProperty(issue, "path"), maximumValidationPathSegments)
        ?.map((part) => readPathSegment(part, reader));
      return Object.freeze({
        message: typeof message === "string" ? reader.clip(message, maximumErrorMessageLength) : "",
        ...(path ? { path: Object.freeze(path) } : {}),
      });
    }),
  );
}

function readPathSegment(part: unknown, reader: BoundedReader): string | number {
  const key = part && typeof part === "object" ? readErrorProperty(part, "key") : part;
  if (typeof key === "number" && Number.isFinite(key)) return key;
  return isPropertyKey(key)
    ? reader.clip(String(key), maximumValidationPathSegmentLength)
    : "[omitted]";
}

// Diagnostics keep only readable, bounded fields; an invalid foreign detail is omitted, not fatal.
function projectDetails(source: object, reader: BoundedReader): ErrorDetails {
  const fields: Record<string, string | number | ReadonlyArray<string>> = {};
  for (const key of Object.keys(detailKinds) as DetailField[]) {
    const raw = readErrorProperty(source, key);
    if (raw === undefined) continue;
    const field = projectDetail(detailKinds[key], raw, reader);
    if (field !== undefined) fields[key] = field;
  }
  return Object.freeze(fields);
}

function projectDetail(
  kind: (typeof detailKinds)[DetailField],
  raw: unknown,
  reader: BoundedReader,
) {
  switch (kind) {
    case "outcome":
      return outcomes.find((outcome) => outcome === raw);
    case "text":
      return typeof raw === "string" ? reader.clip(raw, maximumErrorDetailTextLength) : undefined;
    case "revision":
      return isDetailRevision(raw) ? raw : undefined;
    case "path":
      return reader.strings(raw, maximumErrorDetailPathItems, maximumErrorDetailTextLength);
  }
}

function isRecordableArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}
