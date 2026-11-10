# Migrating from 0.10 to 0.11.0

Upgrade all three packages to 0.11.0 together, then run your application's type checks and integration tests. The [release notes](../reference/release-0.11.0.md) describe the full release scope.

## Update report and error branches

| 0.10.0 | 0.11.0 |
| --- | --- |
| `await queue.settled` | `await queue.settled()` |
| `PlanReport.publishOrder` | Removed; use `prepareOrder` to show preparation order and `execution.atomicPublication` for the publication guarantee |
| `ImpactReason.kind: "start"` / `"stop"` | `"started"` / `"stopped"` |
| `ImpactReason.kind: "provider_changed"` | `"providerChanged"` |
| `PlanOperation.kind: "remove-group"` | `"removeGroup"` |
| `PluginConfigurationDescriptor.status: "none"` | `"schemaAbsent"`; the Plugin type still determines configuration requirements |
| `module_validation`, `configuration_validation`, `core_binding` in `ActivationPreview.deferred` | `moduleValidation`, `configurationValidation`, `coreBinding` |
| Artifact planning error `details.phase: "artifact_planning"` | `"artifactPlanning"` |
| Lifetime busy error code `BUSY` | `LIFETIME_BUSY` |

`PlanReport.intent` still uses `change`, `start` and `stop`. Update persisted reports, test data and UI branches. JSON reports remain inspection data and cannot be restored as executable Plans.

## Respect configuration and resource types

Configuration types are recursively readonly. Create new data and update through a ChangeSet instead of mutating captured configuration.

The `acquire<Result>` type parameter names the factory result, and `Awaited<Result>` must be a resource. Prefer inference; for an explicitly typed asynchronous factory use `acquire<Promise<Connection>>` rather than `acquire<Connection>`. See [Lifetime and resources](./lifetime.md).

Installation snapshots correlate `generation` and `lifetime` with `status`. Registration snapshots correlate `activeOrigin`, `execution` and `error` with their status. The `shutdown` branch of `UnresolvedObligation` has no registration `id`. `ErrorSnapshot.error` and `suppressed` are either both present or both absent. Preserve these relationships in hand-written data and generic wrappers.

## Check runtimes and failure handling

Use a runtime listed in [Getting started](./getting-started.md). `onAbort` callbacks finish synchronously; register cleanup that needs awaiting through `lifetime.interrupt` or `lifetime.defer`.

Snapshot notification failures no longer replace a committed outcome; handle them through the notification error boundaries in the [Core API reference](../reference/core-api.md). Late completion after quarantine only refines diagnostics: it cannot restore the Host or advance `stateRevision`. Applications must still handle the old boundary's resources as described in [Planning and execution](./transactions.md#quarantine).
