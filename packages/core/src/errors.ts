// Error vocabulary for Core. Three jobs, kept apart on purpose:
//
//   DougongError      a failure with a stable machine-readable `code`
//   RecordedFailure   an Error with a bounded pure-value snapshot for objects that must not retain
//                     the failed object graph
//   normalizeFailure  the one place a non-Error rejection reason becomes an Error
//
// `docs/reference/errors.md` lists every code, and the api-surface gate derives
// the codes from this source and fails when the two disagree.

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

/** Bounded diagnostic values, with no references to the failed object graph. */
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

/**
 * A terminal failure is a record, never a reconstruction of the original class.
 * Operations still reject with their live error; retained terminal handles use
 * this class so causes and custom fields cannot retain application resources.
 */
export class RecordedFailure extends Error {
  override readonly name = "RecordedFailure";
  readonly code: string | undefined;
  readonly snapshot: ErrorSnapshot;

  constructor(error: Error) {
    if (!(error instanceof Error)) throw new TypeError("RecordedFailure expects an Error");
    const snapshot = error instanceof RecordedFailure ? error.snapshot : captureError(error);
    super(snapshot.message);
    this.code = snapshot.code;
    this.snapshot = snapshot;
    // Stack text is diagnostic data, not a reference to the original Error.
    if (snapshot.stack !== undefined) this.stack = snapshot.stack;
    Object.freeze(this);
  }
}

function captureError(error: Error): ErrorSnapshot {
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
    if (!(value instanceof Error)) {
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
    const list = (key: string) => {
      const raw = readErrorProperty(value, key);
      if (!Array.isArray(raw)) return undefined;
      if (raw.length > 8) truncated = true;
      // Read each item through the same boundary as other error fields.
      return Array.from({ length: Math.min(raw.length, 8) }, (_, index) =>
        readErrorProperty(raw, index),
      );
    };
    const name = string("name", 256) ?? "Error";
    const message = string("message", 4096) ?? "";
    const stack = string("stack", 16384);
    const code = string("code", 256);
    const cause = readErrorProperty(value, "cause");
    const errors = list("errors");
    const manifestName = string("manifestName", 256);
    const denied = list("denied")
      ?.filter((item): item is string => typeof item === "string")
      .map((item) => clip(item, 256));
    const issues = list("issues")?.map((issue) => {
      const message = readErrorProperty(issue, "message");
      const rawPath = readErrorProperty(issue, "path");
      const path = Array.isArray(rawPath)
        ? Array.from({ length: Math.min(rawPath.length, 16) }, (_, index) => {
            const part = readErrorProperty(rawPath, index);
            const key = part && typeof part === "object" ? readErrorProperty(part, "key") : part;
            return typeof key === "number"
              ? key
              : typeof key === "string" || typeof key === "symbol"
                ? clip(String(key), 256)
                : "[omitted]";
          })
        : undefined;
      if (Array.isArray(rawPath) && rawPath.length > 16) truncated = true;
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

// Error fields are a real external boundary. A throwing accessor must not
// replace the failure being recorded with another failure in its recorder.
function readErrorProperty(value: unknown, key: PropertyKey): unknown {
  try {
    return value && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Internal marker that lets a higher public boundary reclassify the original non-Error reason. */
class NonErrorFailure extends DougongError {}

/**
 * Preserves explicit Error values and classifies non-Error rejection reasons.
 *
 * `throw "nope"` in a Plugin must not become an unnamed failure at the Host
 * boundary, so a non-Error reason is wrapped in a coded Error with the original
 * kept as `cause`. A real Error is returned untouched — Core never rewrites a
 * failure a Plugin author deliberately threw.
 *
 * The private marker class is why re-normalizing is safe: a wrapper that already
 * belongs to Core can be re-coded as it passes an outer boundary instead of
 * being wrapped a second time.
 */
export function normalizeFailure(error: unknown, code: string, message: string): Error {
  if (error instanceof NonErrorFailure) {
    return error.code === code ? error : new NonErrorFailure(code, message, { cause: error.cause });
  }
  return error instanceof Error ? error : new NonErrorFailure(code, message, { cause: error });
}

/**
 * Classifies the exact signal reason or a conventional AbortError, but only
 * after abort.
 *
 * This is the one place Core is allowed to stop propagating a failure, so the
 * test is deliberately narrow. Checking `signal.aborted` first means an
 * `AbortError` thrown by unrelated code on a live signal stays a real error, and
 * only a cancellation that this Lifetime actually requested is treated as one.
 */
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
  return error instanceof Error && error.name === "AbortError";
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

// Issues come from a third-party validator, so they are copied and frozen
// rather than stored by reference. A retained ConfigValidationError otherwise
// keeps whatever object graph that library hung off its issue objects alive.
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
      if (typeof candidate.message !== "string") {
        throw new TypeError(`Config validation issue at index ${index} message must be a string`);
      }
      return Object.freeze({
        message: candidate.message,
        ...(candidate.path === undefined
          ? {}
          : { path: snapshotValidationPath(candidate.path, index) }),
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
