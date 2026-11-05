# Dougong 0.10.0 Release Notes

0.10.0 makes the owner of every asynchronous result, callback, resource, selection and release explicit, and enforces those owners at the public type boundary. This release contains breaking changes from 0.9.0. Follow the [migration guide](https://tangerg.github.io/dougong/en/guide/migrating-to-0.10) when upgrading. [中文发布说明](https://tangerg.github.io/dougong/reference/release-0.10.0).

## Packages

| Package | Version and responsibility |
| --- | --- |
| `dougong` | 0.10.0; contracts, plugins, plans, execution, resources and diagnostics |
| `@dougongjs/platform` | 0.10.0; Artifact catalog, selection, admission, loading and activation |
| `@dougongjs/reactive` | 0.10.0; independent, zero-dependency signals, observation and bridging |

```sh
pnpm add dougong@0.10.0
```

## Breaking changes

- Node.js runtime support is `^24.22.0 || >=26.10.0`; Node.js 22 is no longer supported. Cancellation is classified only from the owning signal's reason, or an `AbortError` whose own `cause` is that reason.
- `Task.result`, `host.use`, `ContributionView.use` and `SerialQueue.run` return `Promise<ResolvedValue<T>>`, delivering successful results in frozen `{ value }` receipts. Result generics use `Awaited<T>`, `Task<T>` names the final payload type and `ObservationTask` is completion-only. Acquisition keeps its `{ resource }` receipt. Foreign Promises are observed through their public `then`.
- Snapshot and Reactive callbacks, including `batch` and `computed`, reject known asynchronous results at the type boundary, and `Observer` gains a result parameter. `Logger` defaults to synchronous methods without business results; unknown logger inputs keep unknown method results.
- An explicit `ChangeSet.install` type argument names the complete argument tuple, such as `InstallationArguments<typeof plugin>`. Installation updates keep each Plugin paired with its input. `BindingReport` correlates required bindings with string providers.
- `platform.select` takes an Artifact array and returns Registrations in the same positions. Artifact and Registration identities are nominal. `ImportLoader` accepts string references only.
- `use` and `acquire` reject handles that control an existing Lifetime registration, and an external resource has one Lifetime owner within a loaded Core. Unreadable setup output is reported as `PROVIDES_INVALID` with its installation.

## Added

- `ResolvedValue` and `InstallationArguments` types in `dougong`, and `resolveValue` and `recordFields` in `dougong/advanced`.
- `asyncDisposeSymbol` and `disposeSymbol` exported from `@dougongjs/reactive` for standalone consumers.

## Fixed

- Asynchronous boundaries observe the operation that owns settlement. A decorated native Promise can no longer finish a borrow, cleanup, queue slot or admission early, or replace a resource before its Lifetime adopts it.
- Early child, cleanup and descendant shutdown failures quarantine the whole Host through Engine's terminal transition. Preparation and restoration cannot commit a healthy state after quarantine.
- An acquisition admitted before its Lifetime sealed can still deliver its resource for a consumer's final flush; a resource that arrives after genuine cancellation is reclaimed by its original owner.
- Final admission stops waiting when the Host invalidates the captured Plan, preparation stays cancellable until Core takes execution authority, and invalid Authorizer results are rejected before load or activation effects.
- Group removal handles overlapping subtrees. Bounded failure snapshots preserve foreign native errors and both branches of a `SuppressedError`.
- Configuration updates are constrained across every installed declaration they may replace, and Standard Schema issue protocols are captured without unrelated metadata.
- Release tooling captures one source commit, push destination and npm registry per release, requires explicit distribution tags, and rolls back only replacements it performed.

## Release verification

The full gate passed on Node.js 24.22.0 with 1221 tests in 87 files, per-package coverage floors, types, lint, formatting, unused-code analysis, dependency cycles, architecture boundaries, builds, public APIs, packed consumers in six browser environments and bilingual documentation. CI derives its version matrix from the runtime baseline and runs the complete gate on the minimum and current versions of every supported release line.

Full changes: [v0.9.0…v0.10.0](https://github.com/Tangerg/dougong/compare/v0.9.0...v0.10.0).
