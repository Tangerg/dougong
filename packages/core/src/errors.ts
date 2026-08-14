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
