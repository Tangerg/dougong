# Core API reference

The main `dougong` package is the actual kernel. Its default surface exposes one explicit execution model. This page records public protocols; [Architecture and design rationale](./architecture.md) explains boundaries and trade-offs, and [Planning and execution](../guide/transactions.md) covers calling and incident handling.

## Public exports

| Responsibility | Exports |
| --- | --- |
| 契约 / Contracts | `service`, `extensionPoint`, `event`, `optional`, `ContractKind`, `ContractValue`, `Service`, `ExtensionPoint`, `Event`, `OptionalService`, `Requirement` |
| 插件 / Plugins | `definePlugin`, `describePlugin`, `PluginDescriptor`, `PluginConfigurationDescriptor`, `PluginDescriptionOptions`, `Plugin`, `AnyPlugin`, `PluginContext`, `Requirements`, `Provisions`, `ResolvedRequirement`, `ResolvedRequirements`, `ProvidedServices`, `InstanceMetadata` |
| 安装与计划 / Installation and planning | `ChangeSet`, `Group`, `Installation`, `InstallationOptions`, `InstallationArguments`, `InstallationUpdate`, `InstallationOrigin`, `InitialInstallation`, `Plan`, `PlanReport`, `BindingReport`, `ImpactReason`, `PlanOperation`, `DeclarationSnapshot`, `captureConfiguration`, `ConfigurationValue` |
| 运行 / Execution | `createHost`, `Host`, `HostOptions`, `ApplyResult`, `HostStatus`, `InstallationState` |
| 资源 / Resources | `createResourceAuthority`, `ResourceAuthority`, `LifetimeContext`, `ChildLifetime`, `LifetimeOwnership`, `Task`, `Cleanup`, `BackgroundTask`, `LifetimePhase`, `LifetimeSnapshot`, `UnresolvedObligation`, `Disposable`, `AsyncDisposable`, `Resource`, `Awaitable`, `ResolvedValue`, `disposeSymbol`, `asyncDisposeSymbol` |
| 事件与贡献 / Events and contributions | `Contribution`, `ContributionView`, `ContributionOperations`, `EventListener`, `EventArguments`, `EventOperations` |
| 观察与错误 / Observation and errors | `HostSnapshot`, `InstallationSnapshot`, `GroupSnapshot`, `SnapshotView`, `isLogger`, `Logger`, `DougongError`, `ConfigurationValidationError`, `RecordedFailure`, `isError`, `isCancellationReason`, `ErrorSnapshot`, `ErrorDetails` |

A plugin receives a `LifetimeContext` with work and resource registration capabilities. Its `child(label)` returns a `ChildLifetime` the caller may dispose. Only the Engine can stop the entire Instance.

`LifetimeContext.acquire(factory)` resolves to a frozen `{ resource }` receipt with the adopted resource; destructure it to use the resource.

Contract identities use their own data fields. A token from another JavaScript realm can supply a provision, declare a requirement or identify a borrow with the same `kind` and `id`.

## Plugin declarations

`Plugin<Configuration, Requires, Provides, ConfigurationInput>` pairs the actual `requires` and `provides` declarations with `setup`. Nonempty mappings require their declaration fields, and callbacks cannot infer undeclared dependencies or provisions. Mappings accept only finite, definite, required string keys; an individual Service token in `provides` cannot independently choose a union branch either. Define complete Plugins before selecting between branches. Declare optional Services with `optional(token)` rather than optional alias fields.

Without a `configuration` schema, `ConfigurationInput` must be directly assignable to `Configuration`; ordinary callers declare the same configuration type for both. Incompatible input and output require an actual Standard Schema: installation accepts its input, and `setup` receives a deeply readonly view of its output. Explicit `Plugin<...>` annotations enforce the same relationships as `definePlugin`.

`AnyPlugin` is an erased declaration boundary and proves no particular configuration or Service value type. Loaders use `capturePluginDeclaration` from `dougong/advanced` to accept unknown module data without asserting it to a concrete `Plugin<...>`.

## Host and installation

`start(signal?)` and `apply(plan, signal?)` can cancel validation or candidate preparation. Cancellation before execution does not consume a Plan. Cancellation during execution joins candidate cleanup and recovery, distinguishing `restored` from `quarantined`; it does not merely abandon an outer Promise. Cancellation after commit cannot rewrite the outcome. `stop()` and standard asynchronous disposal still reject busy during execution to prevent callback self-waits; applications retain and cancel the original request signal. See [Execution and results](../guide/transactions.md#execution-and-results).

`HostOptions` requires `resourceAuthority`; create it once with `createResourceAuthority()` and pass the same authority to every Host sharing the resource domain, including Hosts from separate Core bundles. Other options include `name`, initial `installations`, initial `groups`, and logging and error-reporting ports. Optional `shutdownTimeoutMilliseconds` bounds each Lifetime's shutdown wait, while `restorationTimeoutMilliseconds` bounds preparation when reconstructing previous declarations after a failure; neither falls back to the other or limits normal startup. Installation IDs are unique within a Host. Group IDs are stable identities declared by the application.

`createHost` infers configuration input from each Plugin in the initial list, preserving each pairing in heterogeneous lists. `InitialInstallation<typeof plugin>` and `InstallationOptions<typeof plugin>` derive their configuration requirement from the same Plugin type. Configuration may be omitted when its input accepts `undefined`, including `void`, optional inputs and schema defaults; otherwise it is required. Schema output belongs to setup, while installation declarations still require the schema input. Configuration cannot widen the inferred Plugin type to pass type checking.

`setup` receives a deeply readonly view of configuration output: record fields, nested objects, arrays and tuples cannot be changed. Callers may still supply ordinary mutable input; Core captures the input and validated output without granting the Plugin write access to that data. Schema input and original output types retain their distinct meanings, and explicit configuration types without a schema follow the same readonly rule. Types preserve ordinary interfaces, unions and optional fields. Finite numbers, dense arrays and plain data objects remain requirements checked by the runtime capture boundary.

`ChangeSet.install` preserves the same Plugin/input pairing. `InstallationArguments<First | Second>` distributes complete `[plugin, options]` tuples, and `InitialInstallation` projects this rule for initial declarations. A union Plugin and an independently chosen configuration are rejected, including a missing required input hidden by a `void` branch. Preserve the complete pair when selecting between Plugins:

```ts
const declaration: InstallationArguments<typeof textPlugin | typeof numberPlugin> = useText
  ? [textPlugin, { id: "selected", configuration: "text" }]
  : [numberPlugin, { id: "selected", configuration: 42 }];
const installation = change.install(...declaration);
```

The resulting `Installation<First | Second>` cannot establish its installed branch, so configuration-only updates must satisfy every possible branch. A replacement keeps configuration paired with its new Plugin. Configuration may be omitted to retain captured input only when the replacement accepts every possible previous input; otherwise it must be supplied explicitly. When replacing with an unconfigured Plugin, use `configuration: undefined` to clear a possible previous input. A single Plugin whose input is itself a union, such as `string | number`, still accepts every declared input member.

Installation requires an authoring contract established by `definePlugin` or an explicit `Plugin<...>` annotation; an unannotated raw object is not automatically treated as `AnyPlugin`. The complete contract proof also keeps schema input invariant so equal outputs cannot widen narrower input. After spreading a declaration and changing its contract, call `definePlugin` again; removing a schema or expanding provides cannot retain the old proof. The proof exists only in types and adds no runtime field to a Plugin. Unknown modules enter the explicitly erased dynamic boundary through `capturePluginDeclaration`.

An explicit `install` type argument now describes the complete tuple: `install<InstallationArguments<typeof plugin>>(plugin, options)`. The former `install<typeof plugin>` form has been removed. Ordinary calls continue to infer their types without explicit arguments.

`update` infers the Installation's Plugin contract and the complete update value separately. The actual replacement declaration must pass the same authoring check rather than disappear into the target Installation's broader type. Its explicit form is `update<Declaration, Update>`; the former single type argument has been removed. Ordinary calls retain automatic inference and the pairing between configuration and replacement branches.

To pass the installation command elsewhere, retain `const install = change.install`; its full signature and existing binding remain intact. A wrapper for a known Plugin set can accept `InstallationArguments<First | Second>` and spread it into the call. TypeScript 5.9.3 cannot prove that an unresolved generic `InstallationArguments<P>` preserves its correlation when spread again, so that generic decorator cannot forward directly. Widening it to `AnyPlugin` would erase the input contract.

To retain typed Host options, use `HostOptions<readonly [typeof firstPlugin, typeof secondPlugin]>` for a heterogeneous list. Explicit `AnyPlugin` declarations or `HostOptions` without a type argument erase the concrete input type for dynamic loading boundaries. Unknown configuration still follows the existing data capture and schema validation path, without separate configuration state.

```ts
const change = host.change();
const group = change.group("workspace");
const installation = change.install(plugin, { id: "search", group, configuration });
await host.apply(await host.plan(change));
await host.start();

const next = host.change();
next.update(installation, { configuration: nextConfiguration });
const plan = await host.plan(next);
await host.apply(plan);

const remove = host.change();
remove.removeGroup(group);
await host.apply(await host.plan(remove));
await host.stop();
```

`installation(id)` and `group(id)` query committed declarations. Installation exposes read-only `id`, `groupId`, `status` and `origin`; Group exposes `id` and `parentId`. ChangeSet expresses every mutation. `InstallationUpdate` either updates configuration or replaces a Plugin with configuration and origin.

`host.use(token, callback)` borrows a currently committed Service and returns `Promise<ResolvedValue<Awaited<Result>>>` for the callback's result type `Result`. Destructure `value` from the frozen success receipt; failures retain their original rejection reason. `host.contributions(token)` exposes a contribution view. `host.diagnostics.get()` reads a stable Host snapshot and `host.diagnostics.subscribe()` observes invalidation; `explain(id)` queries one installation's Service bindings. Standard `[Symbol.asyncDispose]` joins stop.

## Execution and diagnostics

Host states are `stopped`, `starting`, `running`, `changing`, `stopping` and `quarantined`. Quarantine is terminal for the entire Host, with no in-place recovery. See [Application handling after quarantine](../guide/transactions.md#quarantine) for operation boundaries and replacement preconditions. `Plan.report` is serializable and contains no modules, functions, real configuration payloads or mutable runtime objects. Lifetimes inside `HostSnapshot` are plain data snapshots too.

Subscriptions share `get/subscribe`, do not replay and use standard Disposable cancellation. `ContributionView.use(id, callback)` borrows the contribution owner and also returns `Promise<ResolvedValue<Awaited<Result>>>`; `get()` exposes only a frozen, ordered list of IDs. Read metadata and invoke handlers inside `use`. `EventOperations.on/emit` supports synchronous or asynchronous listeners; emit awaits all results and aggregates failures, borrowing each listener's owner until completion. `ContributionOperations.add` registers owned contributions.

Callbacks passed to `SnapshotView.subscribe` and `batchSnapshotNotifications` must finish synchronously. Public types reject direct Promise, PromiseLike, objects whose `then` may be callable, and unions containing these asynchronous branches; ordinary synchronous results and data objects containing Promises remain valid. Dynamic inputs and callbacks whose return type was already erased to `() => void` still rely on runtime validation, which cannot retract an asynchronous continuation that has begun. Start background work explicitly with `Lifetime.spawn` from the synchronous notification.

The `SnapshotPublisher` error reporter must also finish synchronously and perform reporting side effects without returning a business result. If a shorthand callback returns the count from `Array.push`, use a block without a return, such as `error => { errors.push(error); }`. A synchronous reporter failure is preserved together with the original subscriber failure; dynamic inputs still pass through the runtime synchronous check.

`batchSnapshotNotifications(operation, reportNotificationFailure?)` can explicitly bind a terminal notification error boundary. When a subscriber and its error reporter both fail, this boundary receives an `AggregateError` containing both original errors without changing the operation's outcome; errors from the operation itself still reach its caller. Omitting the second argument inherits the current boundary. With no boundary, notification failures still throw synchronously to the direct caller. A coalesced notification keeps the boundary captured by its first enqueue: returning from a nested batch or invalidating again cannot transfer that responsibility. Notifications raised by subscribers or reporters inherit the boundary of the notification being delivered.

The terminal reporter must also finish synchronously without a business result. If it fails, both stages of failure are reported as an uncaught error in a separate microtask, without replacing the established operation outcome. Notification delivery remains synchronous and related snapshots remain atomically visible. Core and Platform bind their existing `onError` or logger channels at their publication and cancellation boundaries; real publication, resource cleanup and execution failures retain their rejection and quarantine semantics.

`ErrorDetails` carries outcome, phase, stateRevision and optional installation, contract, dependency path and impact. `RecordedFailure` is a bounded diagnostic projection detached from resource graphs; direct callers still receive the cause of the original rejection.

`isCancellationReason` uses the native signal's reason identity. An arbitrary error with the same name is not cancellation; an `AbortError.cause` data property holding that reason also establishes the relation. See [Lifetime and resources](../guide/lifetime.md) for the full contract.

`apply`, `start` and `stop` resolve with an immutable `ApplyResult` containing `stateRevision` and `affectedInstallations`; failure rejects. A no-op preserves the revision and returns an empty affected list. The result contains no constant success discriminator.

For callers updating from the previous API, replace the removed Host inspect method with `host.diagnostics.get()`. Remove checks of the former ApplyResult outcome field; code after a successful await handles success, while catch handles failures and their structured details. No alias or compatibility adapter is provided.

Host defaults apply when an option is omitted. An explicit null name, installation list or group list is invalid. Declaration, configuration and provided-service records accept null prototypes and native Object prototypes from other realms. Configuration capture reads each shared input object once and freezes its result; cycles and excessive nesting still reject. The logger in `context.logger` exposes standalone callbacks that the plugin may pass to another function. Its disposal belongs to the Instance. Host creation captures each logger method once with its original backend receiver, including the error fallback.

`Logger<Result>` describes the return contract of its four methods and defaults to synchronous completion without a business result. `HostOptions.logger` and `context.logger` use this default; asynchronous Host error reporting belongs in `onError`. Platform logging is a terminal error sink and uses `Logger<unknown>`, accepting asynchronous or other ignored results while observing failures without rewriting a committed outcome. Core's terminal fallback also contains asynchronous failures from dynamic inputs; this does not relax the scoped logger's synchronous requirement.

`isLogger` checks only the four method shapes and narrows to `Logger<unknown>`; it cannot prove synchronous results. `captureLogger` preserves each known input method's return type and returns `Logger<unknown>` for unknown input. Neither operation converts an unknown or asynchronous backend into a synchronous one. Results already erased to `void` upstream still rely on the scoped logger's runtime check.

## Advanced composition primitives

Use `dougong/advanced` for adapters and domain extensions. These primitives expose neither the Engine nor a mutable installation registry.

| Primitive | Responsibility |
| --- | --- |
| `SnapshotPublisher`, `ReadonlyMapSnapshot` | Publish snapshots and expose read-only collections. |
| `batchSnapshotNotifications` | Group publications in one synchronous callback and optionally bind their terminal notification error boundary. A returned Promise cannot extend the boundary. |
| `SerialQueue` | Runs operations in order. `run(operation, signal)` returns `Promise<ResolvedValue<Awaited<T>>>`; `settled()` joins only the operations submitted before it. The optional signal withdraws a waiting operation immediately. Once invoked, the operation owns its settlement. |
| `normalizePlainRecord` | Capture the data fields of a plain record. Use `captureConfiguration` when the input is plugin configuration. |
| `recordFields<T>()(...keys)` | Build an exhaustive accepted-field set from a declaration type for `normalizePlainRecord`. |
| `resolveValue(value)` | Resolve one asynchronous result through the shared protocol and return `Promise<ResolvedValue<Awaited<T>>>`; the frozen `{ value }` receipt preserves the fulfilled identity. |
| `assertSynchronous(value, message)` | Reject an asynchronous return through the same protocol while observing its outcome to prevent an unhandled rejection. Use at synchronous adapter boundaries; it cannot revoke work already started. |
| `captureDataArray(input, label)` | Freeze a shallow copy of dense own index data without invoking the input’s methods or iterator. The caller validates the elements. |
| `captureLogger(logger)` | Capture the four methods and their original receiver once, preserving known return types; unknown input establishes only the method shape. |
| `capturePluginDeclaration(input)` | Capture and validate an immutable `AnyPlugin` from unknown input through the same implementation used by `definePlugin` and Core installation; it runs neither setup nor schema and cannot recover erased configuration or Service types. |
| `onAbort(signal, callback)` | Observe genuine cancellation once, passing its reason immediately if already aborted. The returned function detaches the callback. Dispatching an event named `abort` does not cancel a scope. |

`recordFields` requires every field at compile time, including optional fields and fields from each union member, and rejects extra fields. Each tuple element must name one definite field; a union-valued element cannot stand in for an exhaustive enumeration. Widened arrays, numeric or symbol keys, and open index signatures cannot prove completeness. The set declares which fields may occur; the input boundary still owns required-field and value validation.

An earlier listener calling `stopImmediatePropagation()` cannot suppress genuine cancellation. Core and Reactive share the same native-state and detachment protocol.

Node and browsers share one composition of public APIs. A native listener on the source owns subscription retention. A private dependent created with `AbortSignal.any` delegates through a weak reference so an abandoned observation cannot keep its source and callback alive. Both paths share one native-state check and detachment operation; synthetic events cannot advance cancellation, and detaching leaves unrelated source listeners intact. An observation on a temporary composite preserves native listener retention while its upstream source remains active.

Shadowing an ordinary controller signal's `aborted`, `reason` or listener methods cannot change genuine cancellation. For `AbortSignal.timeout()` and composite signals, Node's native listener management still reads `aborted`. If a shadow getter throws, registration rolls back and rethrows that exact error. If it returns `true` before cancellation, retain the source signal or unsubscribe function until observation ends so Node cannot collect the pending signal prematurely.

## Declaration descriptions and executable plans

`describePlugin(plugin, { jsonSchemaTarget })` projects a `PluginDescriptor` from the same Plugin declaration for documentation, UI and agent callers. It runs neither setup nor validate and does not guess erased TypeScript interfaces. `PluginConfigurationDescriptor.status` distinguishes `schemaAbsent` (no runtime configuration schema declared), `unavailable` (a validator without a JSON Schema exporter) and `available` (a standard JSON Schema exporter). The default target is `draft-2020-12`. `schemaAbsent` leaves the configuration shape and requiredness unknown: for example, `definePlugin<{ port: number }>(...)` can omit a schema while still requiring configuration at installation. Machine-readable input and output descriptions come from that same declaration through Standard Schema 1.1's Standard JSON Schema protocol, without a separate requiredness flag.

`PluginDescriptor.requires` preserves the relationship between requirement kind and optionality: a Service can be optional or required, while an ExtensionPoint always has `optional: false`. The public type retains that guarantee when callers narrow by `kind`.

`PlanReport.bindings.before/after` show binding differences. `stopOrder` and `prepareOrder` describe shutdown and preparation order; every prepared candidate publishes atomically, so there is no separate publication order. Installation `PlanOperation` entries carry before/after `DeclarationSnapshot` data containing only pluginName and public origin, without configuration payloads. Group operations describe id and parentId. `ImpactReason.previousProvider` and provider preserve provider-change explanations, including removal of an optional dependency's provider.

`BindingReport.optional` also discriminates provider availability: `optional: false` guarantees a string `provider`; only `optional: true` permits `provider: undefined`. Graph construction rejects a missing required Service provider before producing a report. `Host.explain()`, diagnostics and Plans share this binding type.
