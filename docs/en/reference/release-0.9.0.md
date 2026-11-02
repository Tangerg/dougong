# Dougong 0.9.0 Release Notes

0.9.0 establishes explicit planning, structured borrowing and resource ownership as Dougong's execution model, and rebuilds delivery around immutable revisions, selection and activation. This release contains breaking changes from 0.8.3. Follow the [migration guide](https://tangerg.github.io/dougong/en/guide/migrating-to-0.9) when upgrading. [中文发布说明](https://tangerg.github.io/dougong/reference/release-0.9.0).

## Packages

| Package | Version and responsibility |
| --- | --- |
| `dougong` | 0.9.0; contracts, plugins, plans, execution, resources and diagnostics |
| `@dougongjs/platform` | 0.9.0; Artifact catalog, selection, admission, loading and activation |
| `@dougongjs/reactive` | 0.9.0; independent, zero-dependency signals, observation and bridging |

```sh
pnpm add dougong@0.9.0
```

Add Platform and Reactive when needed. The former `@dougongjs/core` is merged into `dougong` and has no separate 0.9.0 release. Reusable composition primitives are available through the formal `dougong/advanced` subpath.

## Breaking changes

- Installation changes follow `ChangeSet → host.plan() → host.apply()`. Installation and Group are stable, read-only identities. Former direct installation, handle update/removal, ready and commit paths are removed.
- Application code borrows services with `host.use`. Contribution views return ordered IDs and use `ContributionView.use` for reading and execution. Active borrows protect their generations from destructive changes.
- PluginContext separates `dependencies`, `lifetime`, `events`, `contributions`, `metadata` and `logger`. Configuration fields are named `configuration`, with matching full-length type and error names.
- Configuration inputs and validator outputs accept immutable data only. Resource objects, Promises, functions, accessors, cycles and sparse arrays are rejected. Planning captures configuration and rollback reuses validated values.
- Root `LifetimeContext` registers work and resources; use `ChildLifetime` for independently disposable subtrees. Handles use standard disposal symbols. Asynchronous acquisition returns a `{ resource }` receipt.
- Failed cleanup or restoration quarantines the entire Host permanently. Failed branches retain their actual providers while independently safe branches continue releasing. Late completion does not restore availability.
- Platform owns immutable Artifacts in Catalog and selection intent in Registration; active origin is projected from Core Installation. Explicit revisions, stable Platform IDs and preview/activation replace the previous registration and placeholder flow.
- Recorded permission fields move under `ErrorSnapshot.fields`; Core no longer embeds delivery-domain field names. Directly caught permission exceptions retain their typed properties.
- Firefox support starts at 124. Node.js runtime support is `^24.22.0 || >=26.10.0`, with cancellation adapters built only from public primitives. Published declarations support both Bundler and NodeNext resolution.

## Added

- Plans expose before/after bindings, impact reasons and stop, prepare and publish orders. Authority is Host-bound, revision-bound and single-use. Callers can cancel pending planning.
- `describePlugin` projects contracts and configuration descriptions, including Standard JSON Schema 1.1 exporters, without running setup or validation.
- Lifetime supports standard resource ownership, asynchronous acquisition and blocking I/O interruption, with unresolved obligations exposed in diagnostics.
- `bridge(owner, source)` explicitly connects reactive sources across bundles or module copies without a shared global collector.
- Platform compiles dependency closures and removals into one Core Plan. Admission covers direct activation and this Platform's committed Artifacts restarted by that Plan.

## Fixed

- Cancelled preparation detaches from loaders, validators and authorizers. Never-settling external Promises cannot keep a completed request's Engine or delivery capabilities alive.
- Captured schema protocols are reused across composed declarations, preventing repeated validator wrappers from overflowing the JavaScript stack.
- Selection, removal and disposal publish their state projections before synchronous cancellation callbacks can observe them.
- Task, borrow, event, contribution, configuration and cleanup-handle authority boundaries are stricter. Repeating failed cleanup cannot turn it into apparent success.
- Cancellation uses native AbortSignal state. Synthetic abort events and interrupted propagation cannot forge or starve framework cancellation.
- Disposed bridges release references to their signals and computed subscriber graphs. Observation replacement rechecks cancellation before starting a retired generation.
- Reactive batching captures subscription membership at writes, computed cycles can recover, and misplaced asynchronous handle results are observed before protocol rejection.

## Release verification

Publication uses the same tarballs verified by an isolated consumer, checking hashes, all public entrypoints, declarations, dependencies and runtime files. Uploaded packages are read back from npm and compared file by file before Git records the release. Publication and recovery preserve explicit npm dist-tags; prereleases require a channel.

The full gate covers 936 tests, per-package coverage floors, types, lint, formatting, unused-code analysis, dependency cycles, architecture boundaries, builds, public APIs, packed consumers and bilingual documentation. CI derives its version matrix from the runtime baseline and runs the complete gate on the minimum and current versions of every supported release line.

Full changes: [v0.8.3…v0.9.0](https://github.com/Tangerg/dougong/compare/v0.8.3...v0.9.0).
