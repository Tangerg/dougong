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

An Artifact's `revision` is a caller-supplied content or release identity, never a clock-generated version. Reuse requires the revision and validated Manifest of the same committed Installation to match the selection. The order of dependencies, activation events and permissions does not affect that match. Registration's `selectionRevision` rejects stale activation. `activeOrigin` derives from Installation origin, which is already correct inside Core commit notifications.

Discovery and preview are synchronous. Selection, activation, triggering and removal always return a Promise, including for invalid input. A trigger matches the selections in effect when that command is admitted; an earlier queued selection is included even if its caller has not yet awaited it.

## States and boundaries

Platform states are `active/disposing/disposed`. Registration states are `selected/activating/removing/installed/failed/quarantined/removed`, reflecting selection, active operations and Core execution facts. An aborted caller does not replace the last real failure; a successful activation of the current selection clears it. The root and removal arrays capture their own indexed data slots once. Sparse arrays and accessors are rejected without invoking getters.

`ActivationPreview.deferred` explicitly contains admission, module_validation, configuration_validation, core_binding and setup. Preview is not proof that runtime validation passed. Activation captures selection revision and Artifact identity and rechecks after preparation; stale work cannot overwrite a newer selection.

Manifest dependencies describe delivery relationships; Plugin requires describe actual capability binding. A bundler/HMR adapter owns the import graph, which cannot be guessed from either of those graphs. Example 12 submits the bundler's affected set as one activation plan.

Platform captures the Loader and Authorizer methods once during construction, preserving their receivers. Loader is structural. ImportLoader uses same-realm dynamic import; MemoryLoader supports testing and controlled module tables. PermissionSet implements Authorizer with a declared permission set and provides no operating-system isolation.

During the final activation handoff (Core planning, final admission and apply) or Core release, new mutation commands and disposal reject with `PLATFORM_BUSY`. A callback cannot enqueue work behind itself and wait for it. Earlier admitted activations can finish; loading outside that window remains concurrent. Issue the next command after the outer call completes.

If a caller aborts during validation or final admission, Platform releases the command reservation and discards the late result. Cancellation cannot undo module side effects or revoke a Plan already handed to `host.apply`. Metadata-only removal can still forget a Registration that no longer has a committed Installation.

Registrations affected by one failed activation share one detached error snapshot. Withdrawing the last loading waiter detaches Platform’s continuation from the external promise: even if an adapter never settles, successful disposal no longer retains the Artifact or its delivery ports.

Registration status follows the command executing in Core, including removal during Platform disposal, even if an older request is still loading. Manifest dependency traversal uses an explicit stack; a cycle report contains the closed cycle itself. Platform IDs, Manifest names and dependency names must be well-formed Unicode so they can identify an Installation. The logger is captured with its original receiver at construction.

An activation waiting in the admission or commit queue can be withdrawn immediately while an earlier command is still waiting on application code. A private dependent signal delivers cancellation even if a listener intercepts the original signal’s event.
