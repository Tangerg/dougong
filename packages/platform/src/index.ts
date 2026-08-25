// The public surface of @dougongjs/platform: the delivery boundary for code that
// comes from outside the build.
//
// Platform owns four concerns Core deliberately does not have — declaration
// (Manifest), authorization (Authorizer), loading (Loader) and activation — and
// compiles the result into one Core ChangeSet. It adds no second registry, no
// second dependency graph and no second transaction model; where it looks like
// it does, it is delegating.
//
// The stages, one noun each:
//
//   Manifest + Reference  ->  Artifact  ->  Registration
//   what it claims to be      one candidate   its stable identity here
//
// A Registration is admitted, which is not the same as activated. Registering
// installs at most a placeholder; the real module is loaded when an activation
// event fires.

export { PlatformError, PermissionDeniedError } from "./errors";
export type {
  RegistrationSnapshot,
  RegistrationStatus,
  PlatformSnapshot,
  PlatformStatus,
} from "./diagnostics";
export { defineManifest, type Manifest, type ManifestInput } from "./manifest";
export { ImportLoader, MemoryLoader, type Loader } from "./loader";
export { PermissionSet, type Authorizer } from "./permissions";
export { createPlatform } from "./platform";
export type {
  PlatformOptions,
  Registration,
  Artifact,
  PlatformChangeSet,
  Platform,
} from "./platform-api";
