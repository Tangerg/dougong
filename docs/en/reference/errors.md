# Error codes

Failures reject with structured errors. `DougongError` exposes `code`, immutable `details` and an optional original `cause`. `ConfigurationValidationError` additionally exposes captured Standard Schema issues. `PlatformError` uses `PlatformErrorCode`; `PermissionDeniedError` exposes manifestName and denied permissions.

The `DougongError` constructor validates the declared detail fields. Revision numbers must be nonnegative safe integers, and installation and dependency paths must contain strings. Unknown fields and invalid values throw a TypeError. Recording an external error still omits malformed fields and bounds the diagnostic data.

When migrating Registration diagnostics, read `snapshot.fields?.manifestName` and `snapshot.fields?.denied` in place of the former top-level properties. A caught `PermissionDeniedError` retains its typed fields. To record domain diagnostics, pass up to eight field names of 1 to 256 characters to `new RecordedFailure(error, fieldNames)`. The recorder reads own data properties and captures bounded strings and string arrays.

`details.outcome` distinguishes rejected, restored and quarantined execution. Promise resolution communicates success; `ApplyResult` returns only the state revision and affected installations, without a constant success field. `RecordedFailure` and `ErrorSnapshot` are bounded diagnostic projections, while direct callers receive original failures. Argument and protocol misuse can throw TypeError. Cancellation follows the owning AbortSignal and is not a successful commit.

Diagnostic projections encode direct property keys and `{ key }` path segments through the same rule: finite numbers remain numbers, while non-finite numbers and symbols become bounded strings. `NaN`, `Infinity` and `-Infinity` retain those textual forms instead of becoming `null` during JSON serialization. The original `ConfigurationValidationError.issues` retain their captured Standard Schema property keys.

A native Error from another realm retains its message and causes. When cleanup throws during unwinding, the recorder reads the own data fields `error` and `suppressed` even if the application has renamed the error. Both branches share the diagnostic depth and size budget.

The `error` and `suppressed` fields of `ErrorSnapshot` are either both present or both absent. After checking `snapshot.error !== undefined`, both branches can be read as `ErrorSnapshot` values. If the original error provides only one field, diagnostics do not interpret it as a suppression relationship.

Contribution IDs describe the committed collection snapshot, not guaranteed availability at the moment of borrowing. While an existing contribution update awaits batch publication, `view.get()` can still contain its ID and `view.use()` rejects with `CONTRIBUTION_UNAVAILABLE`. Reread and borrow after a publication notification from `view.subscribe()`; pending publication does not mean permanent removal and does not justify a busy retry loop. A closed owner can also reject borrowing with `LIFETIME_DISPOSED`; handle that according to the owning Lifetime or Host's shutdown state.

| Code | Meaning and response |
| --- | --- |
| `ACTIVATION_FAILED` | Activation execution failed; inspect cause and the structured Core outcome. |
| `ACTIVATION_STALE` | Core state changed during activation preparation; preview and activate again. |
| `API_INCOMPATIBLE` | The Artifact requires an incompatible application API range. |
| `ARTIFACT_DUPLICATE` | The name and revision already exist; use a genuinely new delivery identity. |
| `ARTIFACT_IDENTITY` | The loaded Plugin identity differs from the Manifest, or Platform cannot identify the committed Artifact for an indirect restart. |
| `ARTIFACT_UNAVAILABLE` | The Artifact is unavailable in this Catalog. |
| `BUSY` | The resource owner has foreground borrows and cannot synchronously seal this operation. |
| `CHANGE_CONFLICT` | A change contains conflicting declaration intent. |
| `CHANGE_FOREIGN` | The ChangeSet belongs to another Host. |
| `CONFIGURATION_INVALID` | Standard Schema validation failed; inspect issues and correct the input. |
| `CONTRACT_CONFLICT` | The same Contract ID was used for incompatible contract kinds. |
| `CONTRIBUTION_UNAVAILABLE` | The contribution has not been published, an update awaits batch publication, or it was withdrawn. Reread the available collection after a publication notification before borrowing again. |
| `EVENT_BEFORE_COMMIT` | Candidate setup cannot emit externally before commit. |
| `GROUP_CONFLICT` | Group identity or declarations conflict. |
| `GROUP_CYCLE` | Group parent declarations contain a cycle. |
| `GROUP_FOREIGN` | The Group handle belongs to another Host. |
| `GROUP_MISSING` | A referenced parent or target Group does not exist. |
| `GROUP_REMOVED` | The change attempts to use a removed Group. |
| `HOST_BUSY` | A transition or affected foreground borrow is active; wait, then reuse an unconsumed Plan only if its baseline still matches. |
| `HOST_QUARANTINED` | The entire Host is permanently unavailable; inspect status, error and unresolved, then follow the [quarantine procedure](../guide/transactions.md#quarantine). |
| `INSTALLATION_CONFLICT` | Installation identity or declarations conflict. |
| `INSTALLATION_FOREIGN` | The Installation handle belongs to another Host. |
| `INSTALLATION_REMOVED` | The change attempts to use a removed Installation. |
| `LIFETIME_DISPOSED` | The owner is closed to new resources or work. |
| `MANIFEST_INVALID` | The delivery declaration violates the Manifest protocol. |
| `MODULE_INVALID` | The module does not expose a valid Plugin declaration. |
| `MODULE_LOAD_FAILED` | Loader failed; inspect cause and the input Reference. |
| `PERMISSION_DENIED` | Admission denied permissions; inspect denied and the current policy. |
| `PLAN_CONSUMED` | The Plan has already been consumed; issue another Plan. |
| `PLAN_FOREIGN` | The Plan was not issued by this Host. |
| `PLAN_STALE` | The Plan baseline is stale; plan again. |
| `PLATFORM_BUSY` | A final activation or release is executing; request a new Platform mutation after it returns. |
| `PLATFORM_UNAVAILABLE` | Platform or Catalog is unavailable, or the destination Host is quarantined. |
| `PROVIDES_INVALID` | The setup result is unreadable, has an invalid shape or differs from the declared Service aliases. Read `details.installation` to identify the failing Installation; `cause` preserves the original error thrown while capturing the output. |
| `REGISTRATION_CYCLE` | Selected delivery dependencies contain a cycle. |
| `REGISTRATION_DEPENDENCY_INACTIVE` | A required delivery dependency has no activatable selection. |
| `REGISTRATION_DEPENDENCY_INCOMPATIBLE` | A selected dependency version does not satisfy its Manifest range. |
| `REGISTRATION_DEPENDENCY_MISSING` | A Manifest delivery dependency is missing. |
| `REGISTRATION_UNAVAILABLE` | The Registration is unavailable or belongs to another Platform. |
| `SELECTION_SUPERSEDED` | Selection changed while awaiting work; old results cannot overwrite it. |
| `SERVICE_CONFLICT` | The assembly contains conflicting providers for a Service. |
| `SERVICE_CYCLE` | Required Service bindings form a cycle. |
| `SERVICE_MISSING` | A required Service provider is missing. |
| `SERVICE_UNAVAILABLE` | No committed Service generation is available for borrowing. |
| `SHUTDOWN_TIMEOUT` | Shutdown waiting timed out; underlying obligations may still exist. |
| `TRANSITION_FAILED` | A transition failed; inspect details.outcome and cause for the recovery result. |
