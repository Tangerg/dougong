# Dougong 0.11.0 Release Notes

0.11.0 consolidates ownership of execution state and resource obligations, fixes continued shutdown after quarantine and configuration and snapshot boundaries, and aligns public report names. This release contains breaking changes from 0.10.0. Follow the [migration guide](../guide/migrating-to-0.11.md) when upgrading. [中文发布说明](../../reference/release-0.11.0.md).

## Packages

`dougong`, `@dougongjs/platform` and `@dougongjs/reactive` are released together at 0.11.0.

```sh
pnpm add dougong@0.11.0
```

## Breaking changes

- `SerialQueue.settled` becomes a `settled()` method that waits only for previously submitted operations.
- `PlanReport` removes the redundant `publishOrder`, retaining `stopOrder`, `prepareOrder` and the atomic-publication guarantee. Impact reasons use `started`, `stopped` and `providerChanged`; group removal operations use `removeGroup`.
- The descriptor status for an absent runtime configuration schema changes from `none` to `schemaAbsent`; it does not imply that a plugin has no configuration. Platform previews use `moduleValidation`, `configurationValidation` and `coreBinding`; Artifact planning errors use the `artifactPlanning` phase.
- The busy error for a Lifetime with foreground borrows changes from `BUSY` to `LIFETIME_BUSY`.
- Configuration types are recursively readonly. The `acquire` type parameter names the factory result and validates the final resource. Installation, Registration, unresolved-obligation and error snapshots preserve field relationships through unions; narrow their status or kind before reading dependent fields.
- Runtimes must provide trustworthy native AbortSignal composition; see the [runtime requirements](../guide/getting-started.md). `onAbort` callbacks must finish synchronously.

## Fixes and internal changes

- Engine alone advances the committed graph and revision. Failed startup records diagnostics without advancing the revision, preserving valid Plans; a successful commit clears the earlier failure.
- Quarantine continues shutdown according to each generation's actual dependencies. Waiting for borrows or consumers does not block the initial quarantine report. Late failures refine diagnostics without restoring availability, retrying failed cleanup or advancing the revision.
- Snapshot listener and error-reporter failures follow their notification boundary without replacing committed outcomes. Terminal views detach from runtime resources; prepared dependencies and resource transfers retain their original ownership.
- Reactive bridge preserves the newest reentrant read and subscriber errors. Validation diagnostics encode non-finite numeric property keys as text so JSON cannot replace them with null.
- Publication preserves real terminal descriptors so npm can start browser-based two-factor authentication; registry queries retain their process-group deadlines.
- Identity, option capture, contribution storage and borrowing, shutdown obligations, failure recording and snapshot projection have separate responsibilities while preserving package dependency directions and public entrypoints.

## Release verification

The release script runs the full `pnpm check` gate at the target version: generated files, types, lint, formatting, tests and per-package coverage, unused-code analysis, dependency and architecture boundaries, builds, public APIs, packed consumers in six browser environments and bilingual documentation. It then verifies the archives used for publication. A real-terminal regression test covers publication authentication.

Full changes: [v0.10.0…v0.11.0](https://github.com/Tangerg/dougong/compare/v0.10.0...v0.11.0).
