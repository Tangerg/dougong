# Dougong 0.13.0 Release Notes

0.13.0 adds restored-cancellation classification and a public plugin authoring type.
It also preserves independent setup failures when cancellation enters recovery
before that setup settles. All three packages are released together at 0.13.0:
`dougong`, `@dougongjs/platform` and `@dougongjs/reactive`.

```sh
pnpm add dougong@0.13.0
```

## Adoption from 0.12.0

Existing declarations require no migration. Applications that classify a failed
`host.start(signal)` or `host.apply(plan, signal)` can replace manual combinations
of error code, recovery outcome and cause with `isRestoredCancellation(signal, error)`.
Pre-execution cancellation still uses `isCancellationReason(signal, error)`.
The new classifier is read-only: it does not stop a Host, prove external resources
released or authorize replacement. Join the original lifecycle operations before
retiring an execution boundary or handing over its resources.

Context adapters can derive their declaration fields and setup return values
from `PluginAuthoring<Configuration, Requires, Provides, ConfigurationInput>`.
Use `Pick`, `ReturnType` and `NoInfer` to retain the original finite dependency
and provision constraints, then capture the composed Core declaration through
`capturePluginDeclaration` from `dougong/advanced`. Added application context and
business policies remain with their adapter. Core keeps declaration validation,
committed transitions and Lifetime ownership.

## Correctness

A caller cancellation may enter recovery while setup is still running. The
original preparation attempt now collects independent setup rejections until
candidate cleanup joins that work, then seals its failure result. A known
independent rejection cannot become an ordinary cancellation merely because the
caller also aborted. Errors that arrive after timeout or quarantine continue
through the original reporter without restoring Host availability or retrying
cleanup.

The classifier accepts only the original restored transition error with a direct
cause matching that caller's cancellation. It does not traverse arbitrary cause
chains or mask cleanup, restoration, quarantine, aggregate independent failures
or another caller's reason. Rejection accessors cannot manufacture that match.

## Verification

The release runs `pnpm check` at the target package versions. It verifies types,
negative authoring contracts, cancellation and cleanup ordering, failure identity,
coverage, architecture and public API boundaries, built declarations, installed
Node consumers, Chromium/Firefox/WebKit consumers and documentation.
