import { DougongError } from "@dougongjs/core";

export class PlatformError extends DougongError {
  override name = "PlatformError";

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export class PermissionDeniedError extends PlatformError {
  override name = "PermissionDeniedError";
  readonly manifestName: string;
  readonly denied: ReadonlyArray<string>;

  constructor(manifestName: string, denied: ReadonlyArray<string>) {
    if (
      typeof manifestName !== "string" ||
      manifestName.trim() !== manifestName ||
      manifestName.length === 0
    ) {
      throw new TypeError("PermissionDeniedError manifestName must be a non-empty trimmed string");
    }
    if (!Array.isArray(denied)) {
      throw new TypeError("PermissionDeniedError denied permissions must be an array");
    }
    const immutableDenied = Object.freeze(
      Array.from(denied, (permission, index) => {
        if (
          typeof permission !== "string" ||
          permission.trim() !== permission ||
          permission.length === 0
        ) {
          throw new TypeError(
            `PermissionDeniedError denied permission at index ${index} must be a non-empty trimmed string`,
          );
        }
        return permission;
      }),
    );
    super(
      "PERMISSION_DENIED",
      `Manifest '${manifestName}' was denied permissions: ${immutableDenied.join(", ")}`,
    );
    this.manifestName = manifestName;
    this.denied = immutableDenied;
  }
}
