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

/** Preserves Error values and classifies non-Error rejection reasons. */
export function normalizeFailure(error: unknown, code: string, message: string): Error {
  return error instanceof Error ? error : new DougongError(code, message, { cause: error });
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
      `Invalid plugin config:\n${snapshot.map((issue) => `  - ${issue.message}`).join("\n")}`,
    );
    this.issues = snapshot;
  }
}
