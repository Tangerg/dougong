export class DougongError extends Error {
  override name = "DougongError";

  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

/** Classifies only an AbortSignal's explicit outcome, never arbitrary post-abort failures. */
export function isCancellationReason(signal: AbortSignal, error: unknown) {
  if (!signal.aborted) return false;
  if (Object.is(error, signal.reason)) return true;
  return error instanceof Error && error.name === "AbortError";
}

export interface ValidationIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export class ConfigValidationError extends DougongError {
  override name = "ConfigValidationError";
  readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(issues: ReadonlyArray<ValidationIssue>) {
    const snapshot = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          message: issue.message,
          ...(issue.path === undefined
            ? {}
            : {
                path: Object.freeze(
                  issue.path.map((part) =>
                    typeof part === "object" && part !== null
                      ? Object.freeze({ key: part.key })
                      : part,
                  ),
                ),
              }),
        }),
      ),
    );
    super(
      "CONFIG_INVALID",
      `Invalid Plugin config:\n${snapshot.map((issue) => `  - ${issue.message}`).join("\n")}`,
    );
    this.issues = snapshot;
  }
}
