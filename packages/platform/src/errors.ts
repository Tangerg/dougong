import { DougongError, RecordedFailure, type ErrorDetails } from "dougong";
import { captureDataArray } from "dougong/advanced";

export type PlatformErrorCode =
  | "MANIFEST_INVALID"
  | "API_INCOMPATIBLE"
  | "ARTIFACT_DUPLICATE"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_IDENTITY"
  | "MODULE_LOAD_FAILED"
  | "MODULE_INVALID"
  | "PERMISSION_DENIED"
  | "PLATFORM_BUSY"
  | "PLATFORM_UNAVAILABLE"
  | "REGISTRATION_UNAVAILABLE"
  | "SELECTION_SUPERSEDED"
  | "ACTIVATION_STALE"
  | "ACTIVATION_FAILED"
  | "REGISTRATION_DEPENDENCY_MISSING"
  | "REGISTRATION_DEPENDENCY_INCOMPATIBLE"
  | "REGISTRATION_DEPENDENCY_INACTIVE"
  | "REGISTRATION_CYCLE";

export class PlatformError extends DougongError<PlatformErrorCode> {
  override readonly name: string = "PlatformError";

  constructor(
    code: PlatformErrorCode,
    message: string,
    options?: ErrorOptions & { readonly details?: ErrorDetails },
  ) {
    super(code, message, options);
  }
}

export class PermissionDeniedError extends PlatformError {
  override readonly name: string = "PermissionDeniedError";
  readonly manifestName: string;
  readonly denied: ReadonlyArray<string>;

  constructor(manifestName: string, denied: ReadonlyArray<string>) {
    if (typeof manifestName !== "string" || !manifestName || manifestName.trim() !== manifestName) {
      throw new TypeError("PermissionDeniedError manifestName must be a non-empty trimmed string");
    }
    const immutableDenied = Object.freeze(
      captureDataArray(denied, "PermissionDeniedError denied permissions").map(
        (permission, index) => {
          if (typeof permission !== "string" || !permission || permission.trim() !== permission) {
            throw new TypeError(
              `PermissionDeniedError denied permission at index ${index} must be a non-empty trimmed string`,
            );
          }
          return permission;
        },
      ),
    );
    super(
      "PERMISSION_DENIED",
      `Manifest '${manifestName}' was denied permissions: ${immutableDenied.join(", ")}`,
      { details: { outcome: "rejected", phase: "admission" } },
    );
    this.manifestName = manifestName;
    this.denied = immutableDenied;
  }
}

export function recordPlatformFailure(error: unknown) {
  return new RecordedFailure(error, [
    "manifestName",
    "denied",
  ] satisfies (keyof PermissionDeniedError)[]);
}
