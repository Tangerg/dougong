# Core API reference

The main `dougong` package is the actual kernel. Its default surface exposes one explicit execution model. This page records public protocols; [Architecture and design rationale](./architecture.md) explains boundaries and trade-offs, and [Planning and execution](../guide/transactions.md) covers calling and incident handling.

## Public exports

| Responsibility | Exports |
| --- | --- |
| 契约 / Contracts | `service`, `extensionPoint`, `event`, `optional`, `ContractKind`, `ContractValue`, `Service`, `ExtensionPoint`, `Event`, `OptionalService`, `Requirement` |
| 插件 / Plugins | `definePlugin`, `describePlugin`, `PluginDescriptor`, `PluginConfigDescriptor`, `PluginDescriptionOptions`, `Plugin`, `AnyPlugin`, `PluginContext`, `Requirements`, `Provisions`, `ResolvedRequirement`, `ResolvedRequirements`, `ProvidedServices`, `InstanceMeta` |
| 安装与计划 / Installation and planning | `ChangeSet`, `Group`, `Installation`, `InstallationOptions`, `InstallationUpdate`, `InstallationOrigin`, `InitialInstallation`, `Plan`, `PlanReport`, `BindingReport`, `ImpactReason`, `PlanOperation`, `DeclarationSnapshot`, `captureConfig`, `ConfigValue` |
| 运行 / Execution | `createHost`, `Host`, `HostOptions`, `ApplyResult`, `HostStatus`, `InstallationState` |
| 资源 / Resources | `LifetimeContext`, `ChildLifetime`, `LifetimeOwnership`, `Task`, `Cleanup`, `BackgroundTask`, `LifetimePhase`, `LifetimeSnapshot`, `UnresolvedObligation`, `Disposable`, `AsyncDisposable`, `Resource`, `Awaitable`, `disposeSymbol`, `asyncDisposeSymbol` |
| 事件与贡献 / Events and contributions | `Contribution`, `ContributionView`, `ContributionOperations`, `EventListener`, `EventArguments`, `EventOperations` |
| 观察与错误 / Observation and errors | `HostSnapshot`, `InstallationSnapshot`, `GroupSnapshot`, `SnapshotView`, `isLogger`, `Logger`, `DougongError`, `ConfigValidationError`, `RecordedFailure`, `isError`, `isCancellationReason`, `ErrorSnapshot`, `ErrorDetails` |

A plugin receives a `LifetimeContext` with work and resource registration capabilities. Its `child(label)` returns a `ChildLifetime` the caller may dispose. Only the Engine can stop the entire Instance.

## Host and installation

`HostOptions` contains `name`, initial `installations`, initial `groups`, logging and error-reporting ports, and shutdown timeout. Installation IDs are unique within a Host. Group IDs are stable identities declared by the application.

```ts
const change = host.change();
const group = change.group("workspace");
const installation = change.install(plugin, { id: "search", group, config });
await host.apply(await host.plan(change));
await host.start();

const next = host.change();
next.update(installation, { config: nextConfig });
const plan = await host.plan(next);
await host.apply(plan);

const remove = host.change();
remove.removeGroup(group);
await host.apply(await host.plan(remove));
await host.stop();
```

`installation(id)` and `group(id)` query committed declarations. Installation exposes read-only `id`, `groupId`, `status` and `origin`; Group exposes `id` and `parentId`. ChangeSet expresses every mutation. `InstallationUpdate` either updates configuration or replaces a Plugin with configuration and origin.

`host.use(token, callback)` borrows a currently committed Service. `host.contributions(token)` exposes a contribution view. `host.diagnostics.get()` reads a stable Host snapshot and `host.diagnostics.subscribe()` observes invalidation; `explain(id)` queries one installation's Service bindings. Standard `[Symbol.asyncDispose]` joins stop.

## Execution and diagnostics

Host states are `stopped`, `starting`, `running`, `changing`, `stopping` and `quarantined`. Quarantine is terminal for the entire Host, with no in-place recovery. See [Application handling after quarantine](../guide/transactions.md#quarantine) for operation boundaries and replacement preconditions. `Plan.report` is serializable and contains no modules, functions, real configuration payloads or mutable runtime objects. Lifetimes inside `HostSnapshot` are plain data snapshots too.

Subscriptions share `get/subscribe`, do not replay and use standard Disposable cancellation. `ContributionView.use(id, fn)` borrows the contribution owner; `get()` provides a collection snapshot. `EventOperations.on/emit` supports synchronous or asynchronous listeners; emit awaits all results and aggregates failures, borrowing each listener's owner until completion. `ContributionOperations.add` registers owned contributions.

`ErrorDetails` carries outcome, phase, stateRevision and optional installation, contract, dependency path and impact. `RecordedFailure` is a bounded diagnostic projection detached from resource graphs; direct callers still receive the cause of the original rejection.

`apply`, `start` and `stop` resolve with an immutable `ApplyResult` containing `stateRevision` and `affectedInstallations`; failure rejects. A no-op preserves the revision and returns an empty affected list. The result contains no constant success discriminator.

For callers updating from the previous API, replace the removed Host inspect method with `host.diagnostics.get()`. Remove checks of the former ApplyResult outcome field; code after a successful await handles success, while catch handles failures and their structured details. No alias or compatibility adapter is provided.

Host defaults apply when an option is omitted. An explicit null name, installation list or group list is invalid. Configuration capture reads each shared input object once and freezes its result; cycles and excessive nesting still reject. The logger in `ctx.log` exposes standalone callbacks that the plugin may pass to another function. Its disposal belongs to the Instance.

## Advanced composition primitives

Use `dougong/advanced` for adapters and domain extensions. These primitives expose neither the Engine nor a mutable installation registry.

| Primitive | Responsibility |
| --- | --- |
| `SnapshotPublisher`, `ReadonlyMapSnapshot` | Publish snapshots and expose read-only collections. |
| `batchSnapshotNotifications` | Group publications in one synchronous callback. A returned Promise cannot extend the boundary. |
| `SerialQueue` | Run submitted operations in sequence. |
| `normalizePlainRecord` | Capture the data fields of a plain record. Use `captureConfig` when the input is plugin configuration. |
| `captureDataArray(input, label)` | Freeze a shallow copy of dense own index data without invoking the input’s methods or iterator. The caller validates the elements. |
| `onAbort(signal, callback)` | Observe genuine cancellation once, passing its reason immediately if already aborted. The returned function detaches the callback. Dispatching an event named `abort` does not cancel a scope. |

For future cancellation, the native event must reach the listener. Earlier same-realm code that calls `stopImmediatePropagation()` can suppress that notification; the signal itself remains aborted.

## Declaration descriptions and executable plans

`describePlugin(plugin, { jsonSchemaTarget })` projects a `PluginDescriptor` from the same Plugin declaration for documentation, UI and agent callers. It runs neither setup nor validate and does not guess erased TypeScript interfaces. `PluginConfigDescriptor.status` distinguishes `none` (no configuration), `unavailable` (a validator without a JSON Schema exporter) and `available` (a standard JSON Schema exporter). The default target is `draft-2020-12`. Standard Schema 1.1's Standard JSON Schema protocol exports input and output descriptions; schemas without that protocol remain explicitly unavailable.

`PlanReport.bindings.before/after` show binding differences. `prepareOrder`, `stopOrder` and `publishOrder` describe preparation, shutdown and publication order. Installation `PlanOperation` entries carry before/after `DeclarationSnapshot` data containing only pluginName and public origin, without configuration payloads. Group operations describe id and parentId. `ImpactReason.previousProvider` and provider preserve provider-change explanations, including removal of an optional dependency's provider.
