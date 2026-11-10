export { PlatformError, type PlatformErrorCode } from "./errors.js";
export { defineManifest, type Manifest, type ManifestInput } from "./artifacts/manifest.js";
export type {
  Artifact,
  ArtifactInput,
  ArtifactDescriptor,
  ArtifactOrigin,
} from "./artifacts/artifact.js";
export type { Catalog } from "./catalog/catalog.js";
export type {
  Registration,
  RegistrationSnapshot,
  RegistrationStatus,
} from "./catalog/registration.js";
export { ImportLoader, MemoryLoader, type Loader } from "./loaders/loader.js";
export {
  PermissionDeniedError,
  PermissionSet,
  type Authorizer,
  type AdmissionRequest,
} from "./admission/permissions.js";
export { createPlatform, type Platform } from "./activation/platform.js";
export type { PlatformOptions } from "./activation/platform-options.js";
export type { PlatformSnapshot, PlatformStatus } from "./activation/platform-diagnostics.js";
export type {
  ActivationOptions,
  ActivationPreviewOptions,
  ActivationPreview,
  ActivationBlocker,
} from "./activation/plan.js";
