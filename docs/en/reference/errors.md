# Error codes

Failures reject with structured errors. `DougongError` exposes `code`, immutable `details` and an optional original `cause`. `ConfigurationValidationError` additionally exposes captured Standard Schema issues. `PlatformError` uses `PlatformErrorCode`; `PermissionDeniedError` exposes manifestName and denied permissions.

When migrating Registration diagnostics, read `snapshot.fields?.manifestName` and `snapshot.fields?.denied` in place of the former top-level properties. A caught `PermissionDeniedError` retains its typed fields. To record domain diagnostics, pass up to eight field names of 1 to 256 characters to `new RecordedFailure(error, fieldNames)`. The recorder reads own data properties and captures bounded strings and string arrays.

`details.outcome` distinguishes rejected, restored and quarantined execution. Promise resolution communicates success; `ApplyResult` returns only the state revision and affected installations, without a constant success field. `RecordedFailure` and `ErrorSnapshot` are bounded diagnostic projections, while direct callers receive original failures. Argument and protocol misuse can throw TypeError. Cancellation follows the owning AbortSignal and is not a successful commit.

When cleanup throws while another failure is being unwound, a `SuppressedError` snapshot records the cleanup failure under `error` and the preceding failure under `suppressed`. Both branches share the diagnostic depth and size budget.

| Code | Meaning and response |
| --- | --- |
| `ACTIVATION_FAILED` | Activation execution failed; inspect cause and the structured Core outcome. |
| `ACTIVATION_STALE` | Core state changed during activation preparation; preview and activate again. |
| `API_INCOMPATIBLE` | The Artifact requires an incompatible host API range. |
| `ARTIFACT_DUPLICATE` | The name and revision already exist; use a genuinely new delivery identity. |
| `ARTIFACT_IDENTITY` | The loaded Plugin identity differs from the Manifest, or Platform cannot identify the committed Artifact for an indirect restart. |
| `ARTIFACT_UNAVAILABLE` | The Artifact is unavailable in this Catalog. |
| `BUSY` | The resource owner has foreground borrows and cannot synchronously seal this operation. |
| `CHANGE_CONFLICT` | A change contains conflicting declaration intent. |
| `CHANGE_FOREIGN` | The ChangeSet belongs to another Host. |
| `CONFIGURATION_INVALID` | Standard Schema validation failed; inspect issues and correct the input. |
| `CONTRACT_CONFLICT` | The same Contract ID was used for incompatible contract kinds. |
| `CONTRIBUTION_UNAVAILABLE` | The contribution was withdrawn or its owner no longer accepts calls. |
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
| `PROVIDES_INVALID` | The setup result has an invalid shape or differs from the declared Service aliases. Read `details.installation` on this error to identify the failing Installation. |
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
