# Migrating from 0.9 to 0.10.0

0.10.0 makes the owner of every asynchronous result, callback, resource and Platform selection explicit at the type boundary. Upgrading from 0.9 requires source changes; removed shapes have no aliases or compatibility adapters. The [release notes](../reference/release-0.10.0.md) describe the full release scope. When upgrading from 0.8.3, complete [Migrating to 0.9.0](./migrating-to-0.9.md) first; its examples already use the 0.10.0 API.

Most changes surface as type errors. Upgrade all three packages together, type-check, and work through the sections below.

## 1. Update the runtime

Packages support <!-- runtime-baseline:start -->Node.js `^24.22.0 || >=26.10.0`, Chrome ≥ 119, Edge ≥ 119, Firefox ≥ 124, Safari ≥ 17.4<!-- runtime-baseline:end -->. Node.js 22 is no longer supported.

`isCancellationReason(signal, error)` and Dougong's own classification accept only the owning signal's reason, or an `AbortError` whose own `cause` property is that reason. An `AbortError` matched by name alone remains an ordinary failure. Custom adapters should propagate `signal.reason` rather than constructing a fresh abort error; see [Lifetime and resources](./lifetime.md).

## 2. Destructure successful result receipts

`Task.result`, `host.use`, `ContributionView.use` and `SerialQueue.run` fulfill with a frozen `{ value }` receipt (`ResolvedValue<T>`). Replace `const result = await operation` with `const { value: result } = await operation`; calls that only wait for completion need no destructuring. `acquire` continues to return `{ resource }`. Errors still propagate as Promise rejections.

```ts
const { value: answer } = await host.use(SEARCH, (search) => search.query(query));
```

Input result generics use `Awaited<T>`, and `Task<T>` names the final payload type. `ObservationTask` reports completion only and takes no type argument. The receipt carries data; it does not extend a borrow beyond its callback, as [Application code](./application-code.md) explains.

Foreign Promises are observed through their public `then`. Cross-realm Promises must keep a working public `then`; hidden or misleading `then` methods, or a replaced local Promise prototype chain, are outside the protocol guarantee. Adapt such values in their origin realm. See [Lifetime and resources](./lifetime.md).

## 3. Keep notifications and logging synchronous

Snapshot and reactive `subscribe`, `batchSnapshotNotifications`, `batch`, `computed` and `observe` reject statically recognizable asynchronous results, including calls explicitly specifying `void`. Subscription and observation callbacks finish registration synchronously and register asynchronous work through `lifetime.spawn`. Do not cast away an asynchronous callback; results already erased to `unknown`, `any` or `() => void` still require runtime checks.

The third parameter of `Observer<T, Child, Result>` describes its synchronous result and defaults to `void`. Ordinary `observe(...)` calls infer it. When explicitly supplying the first two type arguments and returning data, supply the third argument as well, or make a notification-only callback return nothing.

A `SnapshotPublisher` error reporter performs synchronous side effects and returns no business value. Replace `error => errors.push(error)` with `error => { errors.push(error); }`; do not pass an asynchronous reporter.

`Logger` defaults to four methods that finish synchronously without business results. Host backends and plugin-scoped logging use this contract; direct asynchronous methods are rejected at the type boundary. Move asynchronous Host error reporting to `onError`, and change logging shorthand that returns a count or other incidental value into a block without a return. Platform's terminal logger uses `Logger<unknown>` and continues to observe asynchronous results.

`captureLogger` keeps known method result types. Both `captureLogger(unknown)` and `isLogger` establish only `Logger<unknown>`; method presence does not prove a synchronous backend, so establish its contract at the integration boundary.

## 4. Correlate bindings and installation arguments

`BindingReport` uses `optional` to distinguish bindings: `optional: false` requires a string `provider`; only optional bindings may lack a provider. Hand-written reports and test fixtures must preserve this relationship.

An explicit type argument to `ChangeSet.install` names the complete argument tuple, such as `InstallationArguments<typeof plugin>`, rather than the Plugin type. Ordinary calls continue to infer the tuple. Installation updates keep each Plugin paired with its input and require explicit configuration when the replacement cannot accept every earlier input.

## 5. Select Artifacts as one batch

`platform.select` takes an Artifact array and returns Registrations in the same positions, so a batch is selected atomically. Artifact and Registration identities are nominal; obtain them from the Catalog and Platform rather than constructing matching objects. `ImportLoader` accepts string references only; capture `URL.href` when declaring the Artifact. See [External plugin delivery](./platform.md).

```ts
const [registration] = await platform.select([artifact]);
await platform.activate([registration]);
```

## Finish the migration

Setup output that cannot be read is reported as [`PROVIDES_INVALID`](../reference/errors.md) with its installation. Handles returned by child Lifetimes, tasks, `defer`, `interrupt`, listeners and contributions control their original registration; `use` and `acquire` reject them. Call the handle's standard disposal method instead, as [Lifetime and resources](./lifetime.md) describes.

After upgrading, exercise borrowing, busy rejection, shutdown, quarantine and Platform activation as listed at the end of [Migrating to 0.9.0](./migrating-to-0.9.md#handle-failure-and-finish-the-migration).
