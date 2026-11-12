# Dougong 0.12.0 Release Notes

0.12.0 makes resource identity domains explicit across Hosts and Core copies, tightens plugin authoring contracts, and adds request cancellation and restoration waiting controls. It also repairs ownership boundaries in resources, contributions, asynchronous settlement, Platform observation and release recovery. This release has breaking changes from 0.11.0; follow the [migration guide](../guide/migrating-to-0.12.md). [中文发布说明](../../reference/release-0.12.0.md).

## Packages

`dougong`, `@dougongjs/platform` and `@dougongjs/reactive` are released together at 0.12.0.

```sh
pnpm add dougong@0.12.0
```

## Breaking changes

- `createHost` requires options with an explicit `resourceAuthority`. Hosts and Core copies sharing resources use the same authority; Lifetime remains the sole owner of actual release obligations.
- Installation and replacement preserve a checked Plugin authoring contract. Dependency and provision aliases must be finite, definite and required. Static checks reject raw objects, independently combined union maps and setup functions, and configuration transformations asserted only through type parameters.
- Intrinsic observation owns local native Promise settlement; public `then` methods and presentation tags cannot select its source. Adapters must respect the [asynchronous result protocol](../guide/lifetime.md) and its guarantee boundaries.

## New capabilities

- `host.start(signal)` and `host.apply(plan, signal)` accept optional caller cancellation. `restorationTimeoutMilliseconds` bounds restoration preparation waiting.
- The main entrypoint adds `createResourceAuthority` and `ResourceAuthority`. `dougong/advanced` adds `capturePluginDeclaration` and `assertSynchronous`.

## Fixes and internal changes

- Resource claim-release receipts start one attempt, reusing its outcome for reentrant and later calls. Failed release and adoption rollback retain the original Lifetime obligation and independent errors.
- Listeners, contributions and child Lifetimes establish ownership before external control registration. Rejected registration unwinds its own work; the parent joins actual child rollback, and a closed handle cannot erase a failed obligation.
- Contribution views and subscriptions compose synchronous Lifetime cleanup directly, removing parallel leases and duplicate release paths. Failure becomes terminal before notification or diagnostic capture. Repeated disposal rethrows the original cause without retrying, including `undefined`.
- Dependency preparation failures enter the same layer's cancellation and rollback. Failed caller-cancellation attachment leaves the Plan unconsumed and running Instances open.
- Setup, tasks, acquisition and Platform planning and execution observe actual Promise settlement. Structural wrapping cannot finish owned work early, replace a real failure or assimilate an already fulfilled native payload again.
- Reactive observation captures cancellation before inline work can stop it. Disposal joins source observation, the current child Lifetime and drain work, preserving independent drain and cleanup failures.
- Platform commit outcomes are separate from diagnostic reads. Disposal revokes local observation bindings before foreign withdrawal. Admission, cancellation and disposal share one operation record and failure receipt.
- Release sessions join actual descendant exit. Manifest restoration uses one source-bound transaction and one shared outcome. Failed restoration or a moved checkout cannot become apparent success on another call, and restoration is not automatically retried.

## Release verification

The release script runs the complete `pnpm check` gate at the target version: generated files, types, lint, formatting, tests and per-package coverage, unused-code analysis, dependency and architecture boundaries, builds, public APIs, packed consumers in Node and three real browsers, and bilingual documentation. Publication verifies the same consumer-tested archives before and after upload.

Full changes: [v0.11.0…v0.12.0](https://github.com/Tangerg/dougong/compare/v0.11.0...v0.12.0).
