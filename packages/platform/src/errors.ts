import { DougongError, RecordedFailure, type ErrorDetails } from "dougong";
import { captureDataArray } from "dougong/advanced";

export const manifestInvalidCode = "MANIFEST_INVALID";
export const apiIncompatibleCode = "API_INCOMPATIBLE";
export const artifactDuplicateCode = "ARTIFACT_DUPLICATE";
export const artifactUnavailableCode = "ARTIFACT_UNAVAILABLE";
export const artifactIdentityCode = "ARTIFACT_IDENTITY";
export const moduleLoadFailedCode = "MODULE_LOAD_FAILED";
export const moduleInvalidCode = "MODULE_INVALID";
const permissionDeniedCode = "PERMISSION_DENIED";
export const platformBusyCode = "PLATFORM_BUSY";
export const platformUnavailableCode = "PLATFORM_UNAVAILABLE";
export const registrationUnavailableCode = "REGISTRATION_UNAVAILABLE";
export const selectionSupersededCode = "SELECTION_SUPERSEDED";
export const activationStaleCode = "ACTIVATION_STALE";
export const activationFailedCode = "ACTIVATION_FAILED";
export const registrationDependencyMissingCode = "REGISTRATION_DEPENDENCY_MISSING";
export const registrationDependencyIncompatibleCode = "REGISTRATION_DEPENDENCY_INCOMPATIBLE";
export const registrationDependencyInactiveCode = "REGISTRATION_DEPENDENCY_INACTIVE";
export const registrationCycleCode = "REGISTRATION_CYCLE";

export type PlatformErrorCode =
  | typeof manifestInvalidCode
  | typeof apiIncompatibleCode
  | typeof artifactDuplicateCode
  | typeof artifactUnavailableCode
  | typeof artifactIdentityCode
  | typeof moduleLoadFailedCode
  | typeof moduleInvalidCode
  | typeof permissionDeniedCode
  | typeof platformBusyCode
  | typeof platformUnavailableCode
  | typeof registrationUnavailableCode
  | typeof selectionSupersededCode
  | typeof activationStaleCode
  | typeof activationFailedCode
  | typeof registrationDependencyMissingCode
  | typeof registrationDependencyIncompatibleCode
  | typeof registrationDependencyInactiveCode
  | typeof registrationCycleCode;

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
      permissionDeniedCode,
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
