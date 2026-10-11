import type { StandardSchemaV1 } from "@standard-schema/spec";

export class DougongError extends Error {
  override name = "DougongError";
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    if (typeof code !== "string" || code.trim() !== code || code.length === 0) {
      throw new TypeError("DougongError code must be a non-empty trimmed string");
    }
    if (typeof message !== "string") throw new TypeError("DougongError message must be a string");
    super(message, options);
    this.code = code;
  }
}

export interface ErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: ErrorSnapshot;
  readonly errors?: ReadonlyArray<ErrorSnapshot>;
  readonly manifestName?: string;
  readonly denied?: ReadonlyArray<string>;
  readonly issues?: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
  }>;
  readonly truncated?: true;
}

// Terminal diagnostics must not retain application resources through Error causes or custom fields.
export class RecordedFailure extends Error {
  override readonly name = "RecordedFailure";
  readonly code: string | undefined;
  readonly #snapshot: ErrorSnapshot;

  get snapshot() {
    return this.#snapshot;
  }

  constructor(error: unknown) {
    const snapshot =
      error !== null && typeof error === "object" && #snapshot in error
        ? error.#snapshot
        : captureError(error);
    super(snapshot.message);
    this.code = snapshot.code;
    this.#snapshot = snapshot;
    // Replace even a missing stack so V8 constructor frames cannot retain the recorded application.
    this.stack = snapshot.stack ?? `${this.name}: ${snapshot.message}`;
    Object.freeze(this);
  }
}

function captureError(error: unknown): ErrorSnapshot {
  const seen = new Set<unknown>();
  let remaining = 32;
  const visit = (value: unknown, depth: number): ErrorSnapshot => {
    if (depth > 4 || remaining-- <= 0 || seen.has(value)) {
      return Object.freeze({
        name: "TruncatedError",
        message: "Error chain truncated",
        truncated: true,
      });
    }
    if (!isError(value)) {
      const message =
        value === null ||
        ["string", "number", "boolean", "undefined", "bigint", "symbol"].includes(typeof value)
          ? String(value).slice(0, 4096)
          : "Non-Error object omitted";
      return Object.freeze({ name: "NonError", message });
    }
    seen.add(value);
    let truncated = false;
    const clip = (raw: string, limit: number) => {
      if (raw.length > limit) truncated = true;
      return raw.slice(0, limit);
    };
    const string = (key: string, limit: number) => {
      const raw = readErrorProperty(value, key);
      return typeof raw === "string" ? clip(raw, limit) : undefined;
    };
    const list = (container: unknown, key: string, limit: number) => {
      const raw = readErrorProperty(container, key);
      if (!isRecordableArray(raw)) return undefined;
      const length = readErrorProperty(raw, "length");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        return undefined;
      }
      if (length > limit) truncated = true;
      return Array.from({ length: Math.min(length, limit) }, (_, index) =>
        readErrorProperty(raw, index),
      );
    };
    const name = string("name", 256) ?? "Error";
    const message = string("message", 4096) ?? "";
    const stack = string("stack", 16384);
    const code = string("code", 256);
    const cause = readErrorProperty(value, "cause");
    const errors = list(value, "errors", 8);
    const manifestName = string("manifestName", 256);
    const denied = list(value, "denied", 8)
      ?.filter((item): item is string => typeof item === "string")
      .map((item) => clip(item, 256));
    const issues = list(value, "issues", 8)?.map((issue) => {
      const message = readErrorProperty(issue, "message");
      const path = list(issue, "path", 16)?.map((part) => {
        const key = part && typeof part === "object" ? readErrorProperty(part, "key") : part;
        return typeof key === "number"
          ? key
          : typeof key === "string" || typeof key === "symbol"
            ? clip(String(key), 256)
            : "[omitted]";
      });
      return Object.freeze({
        message: typeof message === "string" ? clip(message, 4096) : "",
        ...(path ? { path: Object.freeze(path) } : {}),
      });
    });
    return Object.freeze({
      name,
      message,
      ...(code === undefined ? {} : { code }),
      ...(stack === undefined ? {} : { stack }),
      ...(cause === undefined ? {} : { cause: visit(cause, depth + 1) }),
      ...(errors === undefined
        ? {}
        : { errors: Object.freeze(errors.map((error) => visit(error, depth + 1))) }),
      ...(manifestName === undefined ? {} : { manifestName }),
      ...(denied === undefined ? {} : { denied: Object.freeze(denied) }),
      ...(issues === undefined ? {} : { issues: Object.freeze(issues) }),
      ...(truncated ? { truncated: true as const } : {}),
    });
  };
  return visit(error, 0);
}

// Unreadable prototypes do not prove that a rejection value is an Error.
export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isRecordableArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function readErrorProperty(value: unknown, key: PropertyKey): unknown {
  try {
    return value && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

// Only normalization grants provenance; copying constructors or prototypes cannot authorize reclassification.
const normalizedFailures = new WeakSet<Error>();

export function normalizeFailure(error: unknown, code: string, message: string): Error {
  let reason = error;
  if (isError(error)) {
    if (!normalizedFailures.has(error)) return error;
    if ((error as DougongError).code === code) return error;
    reason = error.cause;
  }
  const failure = new DougongError(code, message, { cause: reason });
  Object.freeze(failure);
  normalizedFailures.add(failure);
  return failure;
}

// A live signal must not classify an unrelated AbortError as requested cancellation.
export function isCancellationReason(signal: AbortSignal, error: unknown) {
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function" ||
    typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("Cancellation classifier expects an AbortSignal");
  }
  if (!signal.aborted) return false;
  if (Object.is(error, signal.reason)) return true;
  return isError(error) && readErrorProperty(error, "name") === "AbortError";
}

export class ConfigValidationError extends DougongError {
  override name = "ConfigValidationError";
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    const snapshot = snapshotValidationIssues(issues);
    super(
      "CONFIG_INVALID",
      `Invalid Plugin config:\n${snapshot.map((issue) => `  - ${issue.message}`).join("\n")}`,
    );
    this.issues = snapshot;
  }
}

// Copy validator issues so retained errors cannot retain third-party object graphs.
function snapshotValidationIssues(issues: unknown): ReadonlyArray<StandardSchemaV1.Issue> {
  if (!Array.isArray(issues)) {
    throw new TypeError("Config validation issues must be an array");
  }
  return Object.freeze(
    Array.from(issues, (issue: unknown, index) => {
      if (!issue || typeof issue !== "object") {
        throw new TypeError(`Config validation issue at index ${index} must be an object`);
      }
      const candidate = issue as { readonly message?: unknown; readonly path?: unknown };
      const message = candidate.message;
      if (typeof message !== "string") {
        throw new TypeError(`Config validation issue at index ${index} message must be a string`);
      }
      const path = candidate.path;
      return Object.freeze({
        message,
        ...(path === undefined ? {} : { path: snapshotValidationPath(path, index) }),
      });
    }),
  );
}

function snapshotValidationPath(path: unknown, issueIndex: number) {
  if (!Array.isArray(path)) {
    throw new TypeError(`Config validation issue at index ${issueIndex} path must be an array`);
  }
  return Object.freeze(
    Array.from(path, (part: unknown, pathIndex) => {
      if (isPropertyKey(part)) return part;
      if (!part || typeof part !== "object") {
        throw new TypeError(
          `Config validation issue at index ${issueIndex} path segment ${pathIndex} must be a property key`,
        );
      }
      const key = (part as { readonly key?: unknown }).key;
      if (!isPropertyKey(key)) {
        throw new TypeError(
          `Config validation issue at index ${issueIndex} path segment ${pathIndex} must contain a property key`,
        );
      }
      return Object.freeze({ key });
    }),
  );
}

function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === "string" || typeof value === "number" || typeof value === "symbol";
}
