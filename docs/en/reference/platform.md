# Platform specification

`@dougongjs/platform` depends only on formal `dougong` public entrypoints. Runtime exports are `createPlatform`, `defineManifest`, `MemoryLoader`, `ImportLoader`, `PermissionSet`, `PlatformError` and `PermissionDeniedError`.

Type exports: `Platform`, `PlatformOptions`, `PlatformStatus`, `Registration`, `RegistrationStatus`, `RegistrationSnapshot`, `PlatformSnapshot`, `Artifact`, `ArtifactInput`, `ArtifactDescriptor`, `ArtifactOrigin`, `Catalog`, `Manifest`, `ManifestInput`, `Loader`, `Authorizer`, `AdmissionRequest`, `ActivationOptions`, `ActivationPreviewOptions`, `ActivationPreview`, `ActivationBlocker`, `PlatformErrorCode`

## Catalog, selection and execution

| Entry | Behavior |
| --- | --- |
| `catalog.add(input)` | Captures immutable delivery declarations and configuration |
| `catalog.get(name, revision)` / `catalog.list()` | Reads known Artifacts |
| `catalog.remove(artifact)` | Removes a discovery record |
| `registrations()` | Enumerates a frozen array of current Registration handles for commands |
| `select(artifact)` | Sets Registration selection intent |
| `preview(registrations, { remove })` | Checks declaration data and lists deferred checks |
| `activate(registrations, { remove, signal })` | Admits, loads and compiles one Core Plan |
| `trigger(event, options)` | Derives activation targets from selected Manifests |
| `remove(...registrations)` | Reuses the same Core Plan execution for removal |
| `[Symbol.asyncDispose]()` | Cancels pending activation and removes execution owned by this Platform |

`PlatformOptions.id` distinguishes delivery namespaces in a shared Host. Optional `group` must already be committed in the given Host. The host declares `apiVersion`; checking Manifest ranges is an admission concern.

An Artifact's `revision` is a caller-supplied content or release identity, never a clock-generated version. Registration's `selectionRevision` rejects stale activation. `activeOrigin` derives from Installation origin, which is already correct inside Core commit notifications.

## States and boundaries

Platform states are `active/disposing/disposed`. Registration states are `selected/activating/removing/installed/failed/quarantined/removed`, reflecting selection, active operations and Core execution facts. Errors stay observable; failure never masquerades as an installed success.

`ActivationPreview.deferred` explicitly contains admission, module_validation, configuration_validation, core_binding and setup. Preview is not proof that runtime validation passed. Activation captures selection revision and Artifact identity and rechecks after preparation; stale work cannot overwrite a newer selection.

Manifest dependencies describe delivery relationships; Plugin requires describe actual capability binding. A bundler/HMR adapter owns the import graph, which cannot be guessed from either of those graphs. Example 12 submits the bundler's affected set as one activation plan.

Loader is structural. ImportLoader uses same-realm dynamic import; MemoryLoader supports testing and controlled module tables. PermissionSet implements Authorizer with a declared permission set and provides no operating-system isolation.

During the final activation handoff (Core planning, final admission and apply) or Core release, new mutation commands and disposal reject with `PLATFORM_BUSY`. A callback cannot enqueue work behind itself and wait for it. Earlier admitted activations can finish; loading outside that window remains concurrent. Issue the next command after the outer call completes.
