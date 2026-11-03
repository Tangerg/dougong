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

Manifest dependencies describe delivery relationships; Plugin requires describe actual capability binding. A bundler’s hot module replacement adapter owns the import graph, which cannot be guessed from either of those graphs. Example 12 submits the bundler's affected set as one activation plan.

One validation schema defines Manifest input and output types and their immutable representation. `defineManifest` accepts readonly declarations, and its output can be reused as Manifest input. Every valid Registration name also works as a dependency key, including `__proto__`, `constructor` and `toString`; these names represent ordinary dependency edges.

Declaration reading, validation and error-formatting failures report [`MANIFEST_INVALID`](errors.md) and preserve their original `cause`. Zod error maps and locales may run only when a failure is first read, so that evaluation belongs to the same validation boundary.

Before submitting a Core Plan, Platform requests activation admission for direct installations and updates. If the Plan restarts another Artifact owned by this Platform, admission uses its committed origin. A missing or invalid committed origin, an incompatible API range, or an admission denial stops the entire change before setup. Explicitly targeting the affected Registration lets Platform restore its selected Artifact. Dependency planning failures are recorded on selected Registrations that require installation or an update. Preview is read-only. Once Core accepts the plan, rollback can run setup again for previously committed revisions using their prior admission. Direct Host commands and commands from other Platforms operate outside this Platform’s admission hook.

Platform captures the Loader and Authorizer methods once during construction, preserving their receivers. Loader is structural. ImportLoader uses same-realm dynamic import; MemoryLoader supports testing and controlled module tables. PermissionSet implements Authorizer with a declared permission set and provides no operating-system isolation.

`ImportLoader` implements `Loader<string>`. It accepts primitive string module specifiers and rejects `URL` and other objects at runtime without implicit string conversion. Applications capture `url.href` when declaring an Artifact; a changed target requires another Artifact revision. Native module resolution, caching and evaluation cancellation limits still apply. A string specifier does not guarantee content integrity or execution isolation. See the [loading reference example](../guide/platform.md#capture-module-specifiers-in-artifact-declarations).

Other `Loader<Reference>` implementations may define their own opaque reference protocols, including object identities. Platform does not deep-clone those references. Their meaning, mapping stability and integrity guarantees belong to the corresponding Loader and cannot be inferred from the generic type.

An Authorizer grants admission by returning or fulfilling with `undefined` and denies it by throwing or rejecting. Both admission phases reject any other fulfillment with a TypeError. An existing boolean policy must throw when its predicate is false and return normally when it is true.

During Core planning, final admission, apply and release, new selection or activation commands reject with [`PLATFORM_BUSY`](errors.md). Disposal cancels pending planning and admission, including a validator or policy that awaits disposal itself. Once Platform hands a Plan to Core or starts Core release, disposal also rejects with [`PLATFORM_BUSY`](errors.md) so a setup or cleanup callback cannot wait on itself. Earlier admitted activations can finish, and loading outside that window remains concurrent.

If a caller aborts during validation or final admission, Platform releases the command reservation and discards the late result. Cancellation cannot undo module side effects or revoke a Plan already handed to `host.apply`. Metadata-only removal can still forget a Registration that no longer has a committed Installation.

Registrations affected by one failed activation share one detached error snapshot. Withdrawing the last loading waiter detaches Platform’s continuation from the external promise: even if an adapter never settles, successful disposal no longer retains the Artifact or its delivery ports.

Registration status follows the command executing in Core, including removal during Platform disposal, even if an older request is still loading. Manifest dependency traversal uses an explicit stack; a cycle report contains the closed cycle itself. Platform IDs, Manifest names and dependency names must be well-formed Unicode so they can identify an Installation. The logger is captured with its original receiver at construction.

An activation waiting in the admission or commit queue can be withdrawn immediately while an earlier command is still waiting on application code. A private dependent signal delivers cancellation even if a listener intercepts the original signal’s event.

If another Host command advances the revision during final admission, the Core Plan is obsolete. Platform cancels the policy wait and reports a quarantined Host or a removed Group. If the destination remains available, [`ACTIVATION_STALE`](errors.md) includes the expected and current revisions so a new activation can plan against the current Host.

Load admission and module loading also observe destination validity. Removing the Group or quarantining the Host ends the wait immediately, even if the adapter never returns. These failures report [`REGISTRATION_UNAVAILABLE`](errors.md) or [`PLATFORM_UNAVAILABLE`](errors.md) respectively and remain visible in failure diagnostics. Loading has not yet captured a Core Plan revision, so unrelated Host commits do not invalidate a shared load.
