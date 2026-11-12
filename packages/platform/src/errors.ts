import { DougongError } from "dougong";

export const manifestInvalidCode = "MANIFEST_INVALID";
export const apiIncompatibleCode = "API_INCOMPATIBLE";
export const artifactDuplicateCode = "ARTIFACT_DUPLICATE";
export const artifactUnavailableCode = "ARTIFACT_UNAVAILABLE";
export const artifactIdentityCode = "ARTIFACT_IDENTITY";
export const moduleLoadFailedCode = "MODULE_LOAD_FAILED";
export const moduleInvalidCode = "MODULE_INVALID";
export const permissionDeniedCode = "PERMISSION_DENIED";
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
}
