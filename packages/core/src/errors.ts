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

type ErrorSummaryState =
  | {
      readonly category: "coded";
      readonly name: string;
      readonly message: string;
      readonly code: string;
    }
  | {
      readonly category: "typeError" | "error";
      readonly name: string;
      readonly message: string;
    };

/**
 * A primitive-only record of an Error for terminal objects that must not retain
 * the original stack, cause, subclass fields or the object graph behind them.
 */
export class ErrorSummary {
  readonly #state: ErrorSummaryState;

  constructor(error: Error) {
    if (!(error instanceof Error)) throw new TypeError("ErrorSummary expects an Error");
    const name = readErrorString(error, "name", "Error");
    const message = readErrorString(error, "message", "");
    const code = error instanceof DougongError ? readDougongErrorCode(error) : undefined;
    this.#state = Object.freeze(
      code === undefined
        ? {
            category: error instanceof TypeError ? "typeError" : "error",
            name,
            message,
          }
        : {
            category: "coded",
            name,
            message,
            code,
          },
    );
    Object.freeze(this);
  }

  restore(
    createCodedError: (code: string, message: string) => Error = (code, message) =>
      new DougongError(code, message),
  ) {
    const state = this.#state;
    const error =
      state.category === "coded"
        ? createCodedError(state.code, state.message)
        : state.category === "typeError"
          ? new TypeError(state.message)
          : new Error(state.message);
    if (!(error instanceof Error)) {
      throw new TypeError("ErrorSummary coded error factory must return an Error");
    }
    error.name = state.name;
    return error;
  }
}

function readErrorString(error: Error, key: "name" | "message", fallback: string) {
  try {
    const value = error[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function readDougongErrorCode(error: DougongError) {
  try {
    const code = error.code;
    return typeof code === "string" && code.trim() === code && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Internal marker that lets a higher public boundary reclassify the original non-Error reason. */
class NonErrorFailure extends DougongError {}

/** Preserves explicit Error values and classifies non-Error rejection reasons. */
export function normalizeFailure(error: unknown, code: string, message: string): Error {
  if (error instanceof NonErrorFailure) {
    return error.code === code ? error : new NonErrorFailure(code, message, { cause: error.cause });
  }
  return error instanceof Error ? error : new NonErrorFailure(code, message, { cause: error });
}

/** Classifies the exact signal reason or a conventional AbortError, but only after abort. */
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
