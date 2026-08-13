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

  constructor(public readonly issues: ReadonlyArray<ValidationIssue>) {
    super(
      "CONFIG_INVALID",
      `Invalid plugin config:\n${issues.map((issue) => `  - ${issue.message}`).join("\n")}`,
    );
  }
}
