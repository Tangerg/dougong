# Dougong Core API specification

::: tip This is the specification layer
This document is the **observable behaviour specification** for `@dougongjs/core`, organised for precision rather than readability, and used to settle edge cases and implementation consistency.

If you are new to Dougong, read [Core concepts](../guide/concepts.md) and [Writing plugins](../guide/writing-plugins.md) first — they describe the same model, unfolded in learning order.
:::

When an implementation conflicts with this document, fix the implementation or the specification at the root. Do not add compatibility aliases.

Dougong Core is positioned as:

> A capability composition and structured lifetime kernel in pure JavaScript/TypeScript.

It is not an IoC container, a reactive framework, an event framework or a frontend framework. It provides a small set of orthogonal atoms so that advanced capabilities can be composed from ordinary functions and ordinary objects.

## 1. Inviolable design axioms

### 1.1 One path

One abstraction layer and one semantic allow exactly one canonical entry point. Higher-level sugar must expand mechanically onto it and may not own a second state machine, transaction, dependency graph, resource stack or error model.

| Semantic | Sole entry point | Core does not provide |
| --- | --- | --- |
| Install a plugin | `install()` | `use` / `apply` / `load` |
| Modify the installation plan | `change()` | a second transaction / batch |
| Publish a Service | `provides` + the setup return value | `ctx.provide` / `app.provide` |
| Contribute to an Extension | `contribute()` | `add` / `append` / `register` |
| Listen to an Event | `on()` | `listen` / `hook` |
| Emit an Event | `emit()` | `dispatch` / `publish` / `fire` |
| Register a cleanup | `cleanup()` | `using` / `own` / `defer` |
| Create a child lifetime | `lifetime(label)` | `child` / `scope` / `fiber` |
| Start a background task | `spawn()` | `run` / `fork` / `task` |
| Read a live value | `get()` | `.value` / a function call / `getSnapshot()` |
| Subscribe to change | `subscribe()` | `watch` / `listen` / `observeChanges` |
| Update a plugin | `update()` | `replace` / `reload` / `restart` |
| Remove an installation | `remove()` | `uninstall` / `delete` |
| Release a resource | `dispose()` | `close` / `destroy` / `off` |

`app.install()`, `handle.update()` and `handle.remove()` are single-target sugar: internally each creates one one-shot ChangeSet and commits it. They own no second validation, queue or rollback logic.

### 1.2 Composition closure

Composing objects of the same kind preserves the original semantics:

```text
Lifetime + owned resources → Lifetime
Plugin installations + Group → InstallationHandle
Extension contributions + an ordinary composer → Catalog / Pipeline
Core plugins + manifest / loader → a managed external plugin
```

A Group expands mechanically onto the canonical ChangeSet; Platform and reactive `observe()` may compose only through public APIs. None of the three may create a second registry or transaction state machine.

### 1.3 Semantic orthogonality

- A Service expresses a stable capability; it does not broadcast events.
- An Extension holds open contributions; it does not decide ordering, override or business conflict policy.
- An Event expresses a fact that already happened; it queries no result and retains no state.
- A Lifetime manages temporal ownership only; it resolves no dependencies.
- A Group manages installation ownership only; it creates no capability namespace.
- A Plugin does not load other plugins; the loader lives in Platform.
- An Application understands no HTTP, React, database, window or filesystem.

### 1.4 Explicit over implicit

Any relationship that changes capability resolution, lifetime ownership or execution order must be readable directly from a Contract, a `PluginDefinition` or an explicit parameter:

- Service selection is decided solely by the stable Contract ID in `requires`; never by a Group, the call stack, a current workspace or an ancestor context.
- Setup order is decided solely by the Service dependency graph; install order, Events, Extensions and completion timing are never hidden dependencies.
- Resource ownership comes from the Lifetime that created it; transferring across a boundary must be expressed explicitly through an ordinary parameter or a `Disposable`.
- Domain configuration is composed through plugin config, method parameters or an explicit adapter Service — never a global interception chain, a proxy shadow or prototype-chain override.

"Convention defaults" may reduce boilerplate but may not change the semantics above. If deleting a declaration still leaves the runtime guessing the relationship from the environment, the abstraction has become too implicit.

## 2. The capability algebra

Core has four capability atoms and two orchestration atoms:

```text
capability atoms
├── Service      a stable one-to-one capability
├── Extension    a dynamic open contribution set
├── Event        a fact that retains no state
└── Lifetime     resource ownership and cancellation

orchestration atoms
├── Plugin       a capability producer with one setup
└── Application  dependency graph, transactions and instance orchestration
```

| Atom | Retains current value | Changes dynamically | Behaviour after change |
| --- | ---: | ---: | --- |
| Service | yes | provider topology may change | rebuild consumers |
| Extension | yes | contributions add/remove live | notify subscribers |
| Event | no | listeners add/remove | broadcast this fact |
| Lifetime | n/a | children may be created | parent releases all live children |

A signal is a value type inside a capability, not a new Contract kind obtainable through `requires`.

## 3. Contract

Core has exactly six authoring entry points:

```ts
import {
  createApp,
  definePlugin,
  service,
  extension,
  event,
  optional,
} from "@dougongjs/core"
```

Error classes are a catching boundary and do not count against the capability atom budget.

Declaration:

```ts
const DATABASE = service<Database>("app/database")
const ROUTES = extension<Route>("http/routes")
const USER_CREATED = event<User>("users/created")
```

Uniform rules:

- The first argument is a stable string ID and is the runtime identity; object identity plays no part in matching.
- The return value is a frozen plain object whose shape is exactly `{ id, kind }`.
- A Contract holds no runtime state and is reusable across applications.
- The ID must be non-empty with no leading or trailing whitespace. It is case-sensitive, and is neither trimmed nor Unicode-normalised.
- One ID cannot serve two kinds in the same Application; doing so throws `CONTRACT_CONFLICT`.
- Only successfully committed declarations and runtime use by an active Lifetime register a kind. A failed setup, a rollback and an unmatched host read never occupy a Contract ID.
- `optional()` accepts only a Service. An Extension's empty map is already a valid value, and an Event has no notion of a provider.

A fixed Contract ID should be declared exactly once in a codebase and exported from a stable module. TypeScript cannot prevent two modules from writing different type arguments for the same ID.

When one interface needs several static instances, build an explicit Contract family with an ordinary function instead of introducing an implicit scope:

```ts
const workspaceStore = (workspace: string) =>
  service<Store>(`workspace/${encodeURIComponent(workspace)}/store`)

const ALPHA_STORE = workspaceStore("alpha")
const BETA_STORE = workspaceStore("beta")
```

The family function is the single declaration source: the type and the ID namespace are written once, and repeating the call with the same argument yields an equivalent ID without relying on object identity. Providers and consumers must declare the same concrete token. A Contract ID therefore carries both "what the capability is" and "which one is selected" as a stable identity, so the dependency graph, errors and diagnostics never have to explain a second scope tree. A dynamic tenant chosen per request must not expand the plugin graph without bound; use a Service that explicitly accepts a tenant/workspace parameter instead.

Local configuration layering also uses an explicit Service adapter rather than a general `intercept()`:

```ts
const HTTP = service<HttpClient>("http/client")
const ALPHA_HTTP = service<HttpClient>("workspace/alpha/http")

const alphaHttpPlugin = definePlugin({
  name: "workspace.alpha.http",
  requires: { base: HTTP },
  provides: { http: ALPHA_HTTP },
  setup: ctx => ({
    http: withDefaults(ctx.base, { timeout: 5_000 }),
  }),
})
```

The adapter's input, output and affected closure are all visible in the ordinary dependency graph, and the wrapping policy is decided by domain code that actually understands the `HttpClient` type. Core neither guesses method calls with a proxy nor needs a separate configuration-merging protocol.

Core deliberately does not provide `extension.keyed()`, `extension.many()`, `ordered()` or `override()`. Those are Catalog, Pipeline or domain-specific composition policies, not contribution-set atoms.

## 4. PluginDefinition

A plugin has exactly one shape:

```ts
const usersPlugin = definePlugin({
  name: "app.users",
  config: usersConfigSchema,
  requires: {
    db: DATABASE,
    cache: optional(CACHE),
    routes: ROUTES,
  },
  provides: {
    users: USERS,
  },
  setup(ctx, config) {
    const users = createUsers({ db: ctx.db, cache: ctx.cache })

    ctx.contribute(ROUTES, "users.show", {
      method: "GET",
      path: "/users/:id",
      handler: request => users.find(request.params.id),
    })

    return { users }
  },
})
```

Function plugins, plugin base classes, decorators and `{ apply() }` shapes are not supported.

### 4.1 `requires`

Each dependency alias becomes an own property of the context:

```ts
requires: {
  primary: PRIMARY_DATABASE,
  analytics: ANALYTICS_DATABASE,
}

// setup
ctx.primary
ctx.analytics
```

There is no `ctx.get(string)`, service locator, proxy, prototype-chain injection or module declaration merging.

A Service alias yields a stable value; an Extension alias yields a stable `ExtensionView` object. The context and `ctx.meta` are shallow-frozen, but a Service value itself is neither proxied nor frozen.

Reserved aliases:

```text
signal meta log cleanup lifetime spawn on emit contribute
```

### 4.2 `provides`

A Service has one publication path: declare it in `provides` and return a same-named own property from setup.

```ts
provides: { database: DATABASE },
setup() {
  return { database }
}
```

A missing declared output throws `SERVICE_NOT_RETURNED`. Even a ready-made value from the host should be wrapped in an ordinary plugin; Core provides no `app.provide()` branch.

### 4.3 Configuration

Configuration accepts a Standard Schema and distinguishes input from output:

```ts
StandardSchemaV1<ConfigInput, Config>
```

- `install(plugin, input)` receives `ConfigInput`.
- `setup(ctx, config)` receives the validated or transformed `Config`.
- Schemas may validate asynchronously.
- A configuration failure throws `ConfigValidationError` carrying a frozen `issues` list.
- Core neither clones nor deep-freezes config; defensive transformation belongs to the schema.

`definePlugin()` validates structure at definition time; the ChangeSet re-normalises at the install and update boundaries so a JavaScript caller cannot bypass the factory.

## 5. The context API budget

With no dependencies, the context contains only:

```ts
ctx.signal
ctx.meta
ctx.log

ctx.cleanup(disposer)
ctx.lifetime(label)
ctx.spawn(task)
ctx.on(event, listener)
ctx.emit(event, payload)
ctx.contribute(extension, localKey, value)
```

`ctx.signal` is a standard `AbortSignal`. `ctx.meta` is:

```ts
{
  applicationName: string
  pluginName: string
  installationId: string
  groupId: string
}
```

Filesystem, network, window, clipboard, storage, notification and router all belong in Services and must never become a context namespace.

The context provides no `effect()`, `observe()` or `using()`:

- `using(ctx, resource)` expands mechanically to `ctx.cleanup(() => dispose(resource))`.
- reactive `observe(ctx, source, listener)` is fully implementable from `get/subscribe + lifetime/spawn/cleanup`.
- Both live in a higher layer; Core needs no private privilege.

## 6. Service

A Service is a stable snapshot for the lifetime of a plugin instance:

```ts
const db = ctx.db
db === ctx.db // always true while this instance lives
```

Live Service proxies are forbidden. When a provider updates, the Application:

```text
pre-validates the candidate graph and configs
→ stops affected consumers in reverse order
→ stops the old provider
→ starts the new provider
→ rebuilds consumers in dependency order
```

`optional(SERVICE)` follows snapshot semantics too. When a provider goes from absent to present or the reverse, the consumer instance is rebuilt; a live context is never mutated.

Outside the Application and at test boundaries you may read:

```ts
const users = app.get(USERS)
```

`app.get()` accepts only a Service, and succeeds only while the Application is active and that Service is running. Inside a plugin, only declared dependencies are available.

The Application caches the validated dependency graph corresponding to the current active runtime; `app.get()` performs provider and Service map lookups without rebuilding the graph. The idle state allows a stepwise, temporarily incomplete plan, so candidate graphs are built only during `start()` or a ChangeSet committed while the Application is active.

Executing a ChangeSet while the Application is active explicitly enters `changing`, and host `app.get()` refuses reads for that window. It never poses as a stable active state while the old runtime stops and the new one starts. Only after the transaction succeeds or a rollback completes does it re-enter `active` and switch to the corresponding graph; if recovery is impossible it fails closed to `idle`. Host reads therefore see only "before commit" and "after commit"; candidate graphs and half-rebuilt Service maps never leak.

### 6.1 Startup scheduling

The dependency graph uses deterministic topological layers: within a layer there are no Service dependencies, so setups run concurrently, and the next layer waits for the previous layer to commit completely. Each layer has two phases:

```text
prepare: concurrently create Lifetimes, resolve dependencies, run setup, validate Service outputs
commit:  after the whole layer succeeds, publish Services / listeners / contributions in stable install order
```

A failing setup aborts `ctx.signal` for the rest of the layer, waits for every setup in the layer to settle, and releases every prepared Lifetime. A failed layer publishes zero new capabilities; already-committed earlier layers are cleaned up uniformly by the outer startup or ChangeSet rollback boundary.

Concurrency comes only from the explicit Service dependency graph. Events and Extensions establish no startup edge, and the relative start and completion order of independent plugins is undefined. If you need ordering, declare a Service dependency; never rely on install order or timers. Stopping remains serial in full reverse dependency order to keep resource revocation deterministic.

Core currently offers no concurrency-limit configuration. It has no second scheduling mode and presets no process-level policy without data. To limit a class of expensive operations, the relevant Service supplies its own queue or semaphore, because only it knows the resource type and real capacity.

## 7. Extension

### 7.1 The atomic model

Every Extension is:

> A dynamic contribution map owned by plugin installations and identified by stable local keys.

```ts
const ROUTES = extension<Route>("http/routes")

const contribution = ctx.contribute(ROUTES, "users.show", route)
contribution.update(nextRoute)
contribution.dispose()
```

The real key is composed by the runtime:

```text
<escaped plugin installation id>/<escaped local key>
```

where `%` and `/` become `%25` and `%2F`, so the separator cannot make two different (installation ID, local key) pairs produce the same real key, while common keys stay readable.

Therefore:

- different plugins using the same local key do not conflict
- one installation with one local key may have exactly one live contribution
- an update must go through the original Contribution handle
- `undefined` is a legal contribution value; liveness is determined by the real key and record identity, never by using a value as a terminal sentinel
- an obsolete handle is checked by record identity and cannot delete a later contribution with the same key
- stopping a plugin removes all of its contributions
- a failed setup publishes no contribution

### 7.2 The unified observation protocol

```ts
interface ExtensionView<T> {
  get(): ReadonlyMap<string, T>
  subscribe(listener: () => void): Disposable
}
```

`subscribe()` notifies only about future invalidation. It does not fire immediately and carries no value. The caller explicitly performs "read the current value, then subscribe to the future":

```ts
const rebuild = () => {
  router.replace([...ctx.routes.get().values()])
}

rebuild()
ctx.routes.subscribe(rebuild)
```

An ExtensionView obtained from the context assigns its subscriptions to the current Lifetime automatically; early release still uses the returned `dispose()`.

The snapshot is a genuinely read-only map with no `set/delete/clear`. Object identity is preserved when nothing changes, and a new snapshot is created when a change commits. However many times one Extension changes inside a single Core ChangeSet, it notifies exactly once.

An ExtensionView is a live capability owned by the plugin Lifetime, not a store reference that can leak permanently. After a plugin stops, the old view's `get/subscribe` refuse to work and sever the store reference; a new instance receives a new view. The view's public `get/subscribe` come from a narrow handle holding only a revocable binding — an arrow function created inside a store method scope must not implicitly capture the store. This boundary differs from the treatment of an old Service closure: a Service is an ordinary value resolved once, while an ExtensionView keeps observing the runtime.

An exception from a later subscriber goes to the Application `onError` and must not damage the runtime command that produced the notification. The first read and the plugin's own synchronous `rebuild()` errors still fail setup normally.

### 7.3 Higher-level composition

Domain uniqueness, ordering, override and folding must be composed on top of the raw contributions:

```text
Extension<Command> + keyOf(command.id) + conflict policy → CommandCatalog Service
Extension<Middleware> + orderBy(order) + reduceRight    → middleware pipeline
Extension<Theme> + keyOf(theme.id) + stack policy       → ThemeCatalog Service
```

These composers may expose a more domain-appropriate API, but their input must be the public `ExtensionView`, their lifetime must use public cleanup/subscribe, and they may not reach the internal `ExtensionStore`.

## 8. Event

```ts
const TRACK_CHANGED = event<Track>("playback/track-changed")

const subscription = ctx.on(TRACK_CHANGED, listener)
await ctx.emit(TRACK_CHANGED, track)
subscription.dispose()
```

An Event has exactly one dispatch semantic:

- a single payload; use an object for complex arguments
- asynchronous concurrent broadcast to every listener
- awaits all of them
- returns no business result
- if any listener fails it throws an `AggregateError`, even with a single cause
- a listener is owned automatically by the Lifetime that created it
- listeners registered during setup are invisible until setup succeeds

If you need a result, use a Service. If you need an ordered processing chain, use an Extension plus ordinary functions. If you need the current state, use a Service exposing a `Readable`/signal.

An Event is a fact, not state, so an `emit()` is not itself rollback-able. External side effects produced during setup are the plugin's responsibility to compensate; Core's transactional promise covers the framework-visible Services, contributions and listeners.

## 9. Lifetime and Disposable

Every plugin instance inherently owns a root Lifetime. All listeners, contributions, subscriptions, tasks, child Lifetimes and cleanups created through the context belong to it automatically.

The uniform resource protocol:

```ts
interface Disposable {
  dispose(): void | Promise<void>
  [Symbol.dispose]?(): void
  [Symbol.asyncDispose]?(): Promise<void>
}
```

Resource handles are uniformly named `dispose()`; removing a plugin installation from the plan is uniformly `remove()`. The two are never interchangeable.

`dispose()` is the canonical API for resource release; `Symbol.dispose` / `Symbol.asyncDispose` are only that same operation projected onto JavaScript's `using` syntax, and own no second state machine or error semantics.

### 9.1 cleanup

```ts
const handle = ctx.cleanup(() => server.close())
await handle.dispose() // may release early; idempotent
```

Cleanups run in reverse registration order, and one failure never skips earlier resources. A single failure is rethrown as-is; multiple failures aggregate.

### 9.2 Child lifetimes

```ts
const session = ctx.lifetime("session")

session.on(MESSAGE, listener)
session.spawn(signal => pump(signal))
session.cleanup(() => transport.close())

await session.dispose()
```

- a parent releases every still-live child
- releasing a child does not affect the parent
- a child released early detaches from the parent's ownership set
- `dispose()` is idempotent
- the parent context and a child Lifetime use the same resource API
- `label` is a required, non-empty, untrimmed diagnostic description; it takes no part in runtime lookup or identity, and duplicates among siblings are legal
- actively releasing a Lifetime or task cancels its signal with a frozen `AbortError`, while a parent cancellation forwards the parent signal's reason explicitly. Callers classify by `signal.aborted` and the reason's type, never by the reason's object identity
- repeated `dispose()` during an in-flight release shares one completion promise; repeated calls after the terminal state are completed no-ops. The caller that initiated the release still receives the original failure, but a terminal handle stops retaining a rejected promise or its error stack. Once released, a Lifetime expresses its terminal state with a fresh already-aborted signal carrying the same reason, severing the listener closures on the old signal

### 9.3 spawn

```ts
const task = ctx.spawn(signal => synchronize({ signal }))
await task.result
await task.dispose()
```

Releasing a task aborts first, then awaits the result settling. A background failure not handled synchronously by the caller is reported through the Application `onError`; a failure after abort is treated as a cancellation outcome and not reported twice.

A task that settles naturally immediately detaches from the parent Lifetime's ownership set and from the AbortSignal listeners. A later `dispose()` on that task is an idempotent completion and never retroactively aborts the signal of a finished task. Completed tasks do not accumulate in a long-lived owner proportional to history; releasing a parent still aborts and awaits every task that had not settled at that moment.

### 9.4 Stop order

A plugin's stop order is fixed and never depends on registration coincidence:

```text
refuse new context work
→ revoke Services
→ revoke listeners, contributions and extension subscriptions
→ abort the root signal
→ await background tasks
→ release child lifetimes in reverse order
→ run cleanups LIFO
```

Consequently a cleanup may not continue to `emit()` or acquire new resources; stopping has already crossed the "accept new work" boundary.

## 10. Application and ChangeSet

```ts
const app = createApp({
  name: "desktop",
  logger,
  onError,
})
```

### 10.1 Install and start

```ts
const database = app.install(databasePlugin, config)
app.install(usersPlugin)

await app.start()
await database.ready()
```

`install()` synchronously returns a stable handle and queues a single-item ChangeSet onto the Application command queue. Definition-shape errors throw synchronously; commit and startup errors surface through `ready()` / `start()`.

`ready()`'s barrier sits after the whole command: it settles only once candidate-graph validation, the runtime instance switch and the Extension batch publication have all finished. A caller reading an ExtensionView immediately after `await handle.ready()` sees only the committed snapshot and never needs to wait an extra tick.

The command queue linearises install, update, remove, start and stop. One failure never destroys the ability to queue later commands.

Core expresses that semantic with a single `SerialQueue`, which Platform's change and activation queues reuse:

```ts
const commands = new SerialQueue()
const result = commands.run(operation) // the caller receives its own value or error
await commands.settled                 // await everything queued at read time
```

`run()` continues with the next item whether the previous one succeeded or failed; the internal tail records only completion boundaries and never rejects, and each item's raw result goes only to its own caller. It is the command serialization protocol shared by hosts and higher-level orchestrators, and owns no Application, transaction or error-classification state.

### 10.2 PluginHandle

```ts
handle.status
handle.ready()
handle.update({ plugin })
handle.update({ config })
handle.update({ plugin, config })
handle.remove()
```

`update()` covers both config update and definition replacement. The argument must contain at least one of `plugin` or `config`; there is no `replace/reload/restart`. A definition update may not change the plugin name, and the handle and installation ID stay stable.

Once a handle reaches `removed` it revokes its control reference to the Application and releases the plugin definition and config. A terminal `remove()` succeeds idempotently and `update()` rejects with `PLUGIN_REMOVED`; keeping a removed handle never keeps the Application alive.

When an installation fails before commit, a caller already awaiting `ready()` still receives the original `Error`; a non-`Error` rejection reason is explicitly classified as `PLUGIN_UNAVAILABLE` on entering a stable failure state. After the instance detaches from the Application, the handle keeps only a `name/message/code` data summary and reconstructs an error at the call boundary on a later `ready()`. A JavaScript `Error`'s stack may retain the whole orchestration object graph and must not become a hidden ownership edge on a terminal handle. Failed instances still belonging to an active Application keep the original error for diagnostics and retry semantics. Platform's terminal `ManagedPlugin` follows the same rule.

### 10.3 The canonical ChangeSet

```ts
const change = app.change()
change.update(provider, { plugin: providerV2 })
change.update(consumer, { plugin: consumerV2 })
change.remove(legacy)
const extra = change.install(extraPlugin)
await change.commit()
```

Rules:

- one-shot; sealed after the first `commit()`
- commit is idempotent; repeated calls return the same promise
- an empty ChangeSet is a side-effect-free committed no-op that manufactures neither a fake `changing` status nor a diagnostics revision
- one handle may appear only once per ChangeSet
- handles from another Application are rejected
- the candidate dependency graph and every affected config are validated before any instance stops
- during execution the Application is `changing` and host Service reads are closed
- an active change rebuilds only the targets and the affected transitive consumers in the old and new graphs
- multiple changes share one stop, start, rollback and Extension notification boundary

The handle returned by `change.install()` is a draft owned by that ChangeSet. It gains Application control authority only at `commit()`; calling its `update/remove` before that rejects with `PLUGIN_UNAVAILABLE`, so it cannot secretly join a second ChangeSet. `app.install()` returns an immediately controllable handle only because that sugar has already synchronously submitted its internal single-item ChangeSet.

When a change's setup fails, Core releases the partial new runtime and restores the old graph. If old resources cannot be stopped, the new runtime cannot be cleaned up, or the old graph cannot be restored, the Application fails closed to idle rather than falsely reporting active.

### 10.4 stop

`app.stop()` stops in reverse dependency order. The installation plan survives and handles return to pending; a later `start()` recreates instances from the current definitions and configs. Only `remove()` deletes from the plan.

## 11. Group

A Group is installation composition and subtree ownership. It is neither a seventh kernel atom nor a dependency-injection scope:

```ts
const backend = app.group("backend", group => {
  group.install(databasePlugin, config.database)
  group.install(usersPlugin)
  group.group("transport", transport => {
    transport.install(httpPlugin, config.http)
  })
})

await backend.ready()
await backend.remove()
```

Application and Group share the same `install/group/change` verbs. The first configure must be synchronous so every declaration compiles into one ChangeSet; returning a thenable rejects immediately.

Group rules:

- may nest
- every installation inside configure shares one commit
- `ready()` awaits the installations produced by configure crossing the ready barrier
- `remove()` deletes the whole subtree in one Core transaction
- a Group ChangeSet may only modify handles in its own subtree
- `GroupHandle` and `PluginHandle` share `status/ready/remove`; only `PluginHandle` adds `update`
- a Group changes no capability visibility: Services, Extensions and Events belong to the whole Application

Nested Group configures share one explicit configuration session. Any child failure marks the entire session `failed`, so even a caller that catches the exception in an outer scope cannot keep appending declarations or commit a partial configuration. Non-`Error` failure values are classified at the configuration and runtime transaction boundaries as `GROUP_UNAVAILABLE`; after a failed `ready()` the Group status must be `failed` and may not appear healthy merely because the failure value happened to be `undefined`.

Each Group keeps exactly one current readiness barrier. A Group that has not yet been established stays `failed` after a failed commit, and a later successful change replaces the old barrier and establishes it. An already-established Group whose change failed and whose previously committed state Core restored stays healthy. `status` and `ready()` always read the same lifecycle state.

Removing a Group revokes handle authority for the whole subtree at once. A terminal `GroupHandle` keeps only its identity and the `removed` status, `remove()` stays idempotent, and it no longer holds the Application, the configuration session or a historical failure stack, nor can it create installations, child Groups or ChangeSets.

When workspace or tenant separation is needed, choose by semantics: a small fixed number of instances needing independent dependency graphs uses an explicit Contract family; data selected per request at runtime uses a Service taking a tenant/workspace parameter; a fully independent capability graph uses multiple Applications; security isolation uses a Worker, iframe or process. Never pass a Group off as a resolution or security boundary.

## 12. Transactional publication

Starting one topological layer:

```text
1. validate configs
2. resolve stable Service snapshots and ExtensionViews for each plugin in the layer
3. create each root Lifetime and run setup concurrently
4. stage Contract kinds, listeners and contributions; cleanups enter their own rollback stacks immediately
5. validate every Service output in the layer
6. after the whole layer succeeds, register Services and publish staged capabilities in stable install order
7. mark the layer active, then move to the next topological layer
```

When the prepare phase fails:

```text
Published Services         0
Published contributions    0
Published listeners        0
Registered Contract kinds  0
Acquired resources         all release attempted
```

Application start, stop and a ChangeSet committed while active use Extension batches: an observer sees only the pre-operation or post-operation snapshot, never per-plugin intermediates.

## 13. The unified observation protocol and the reactive layer

`ExtensionView`, Application diagnostics, Platform diagnostics and `@dougongjs/reactive` signals all adopt one structural protocol:

```ts
interface Readable<T> {
  get(): T
  subscribe(listener: () => void): Disposable
}
```

Producing such runtime diagnostics uses Core's single write-side primitive, `SnapshotPublisher`:

```ts
const snapshots = new SnapshotPublisher(readSnapshot, reportError)

export const diagnostics = snapshots.view // exposes only get / subscribe
snapshots.invalidate()                     // mark invalid and notify
snapshots.dispose()                        // freeze the terminal state and sever closures
```

`view` is an authority narrowing, not a second observation API: a reader may only `get/subscribe`, and the owner may drive invalidation and termination only through the publisher. `dispose()` freezes the last snapshot before severing the reader, reporter and existing subscriptions, so a historical view can still read the terminal state without keeping the runtime alive. Application, Lifetime and Platform diagnostics all take this path, and no higher layer may rewrite the subscription registry or the error boundary.

Where a snapshot needs map semantics it uniformly uses `ReadonlyMapSnapshot`. It copies the input and exposes only `ReadonlyMap` methods, avoiding the fake immutability of `Object.freeze(new Map())`, on which `set/delete/clear` still work. It guarantees only the container's structural immutability; entry values should be frozen as they enter the snapshot.

`@dougongjs/reactive` is an independent foundation package:

```ts
signal(initial)
computed(calculate)
batch(callback)
observe(lifetimeOwner, source, observer)
```

- a signal holds the current value
- computed auto-tracking applies only to synchronous, pure, lazy, cached computation
- batch accepts only a synchronous callback and coalesces the notifications inside it
- observe is a higher-level Lifetime combinator: it explicitly reads one source, creates a child Lifetime for the current value, and on change releases the old child before creating the new one. The observer must be synchronous, and a failed later replacement stops the observation and releases the subscription and the current child Lifetime

```ts
const endpoint = computed(() => `${base.get()}/${account.get()}`)

observe(ctx, endpoint, (url, lifetime) => {
  const socket = new WebSocket(url)
  lifetime.cleanup(() => socket.close())
})
```

`observe()` uses only the public `get/subscribe/lifetime/spawn/cleanup`, so it is neither a Core privilege nor a second runtime. Core does not depend on reactive, and third-party `Readable`s are structurally compatible.

Structural compatibility unifies only the observation protocol; it does not flatten the ownership boundary of a resource's origin. An ExtensionView injected through the context is a live capability bound to the current Lifetime, and a subscription created directly on it is owned by that Lifetime automatically. A standalone signal or third-party `Readable` has no implicit owner, so a direct subscriber holds the returned `Disposable` itself, or hands it to `observe(owner, source, observer)` to be composed into an explicit Lifetime. Both still have one `subscribe()` and one `dispose()`; the only difference is whether a clear structural owner already exists.

Solid-style bare `effect()`, dependency arrays, deep proxy stores and `watchEffect/autorun/reaction` are not provided. Effect-TS may be used inside a Service or attached through a one-way adapter, but does not enter Core.

## 14. Diagnostics and the encapsulation boundary

```ts
app.diagnostics.get()
app.diagnostics.subscribe(notify)
```

A snapshot contains the Application name/status/revision, a `PluginSnapshot` map and a `GroupSnapshot` map. The snapshot, its entries, arrays and maps are all read-only; diagnostics cannot control the runtime.

A running `PluginSnapshot` also carries an independent `lifetime` observation view:

```ts
interface LifetimeSnapshot {
  readonly label: string
  readonly phase: "active" | "disposing" | "disposed"
  readonly cleanups: number
  readonly tasks: number
  readonly listeners: number
  readonly contributions: number
  readonly extensionViews: number
  readonly subscriptions: number
  readonly children: readonly LifetimeSnapshot[]
}

const lifetime = app.diagnostics.get().plugins.get(id)?.lifetime
const current = lifetime?.get()
const subscription = lifetime?.subscribe(render)
```

The root node's `label` is the stable installation ID, and every `children` entry corresponds strictly to one real `lifetime(label)` ownership relationship. Node counts describe only the resources that Lifetime owns directly, and `children` lists only direct child Lifetimes. Subtree totals are derivable recursively from this irreducible set of facts, so no second aggregate state is stored in the snapshot. The whole snapshot is recursively frozen and exposes no Lifetime, resource object, callback or store.

A label answers only "why do these resources live together". It is not a capability ID, a lookup key or a new scope. Duplicate labels create no conflict and change no release semantics. Leaf resources such as cleanups, tasks and listeners add no naming overloads of their own; a child Lifetime is created only where a shared release boundary genuinely exists. Core never guesses nodes from function names, call stacks or ordinals, and never fabricates tree levels merely to implement categorised counts.

A resource change updates only this small view: it does not bump the Application revision or rebuild every `PluginSnapshot`. A caller wanting to observe resource churn subscribes to the nested view explicitly. A child Lifetime detaches from the tree as soon as it terminates; after a plugin stops, new `PluginSnapshot`s no longer carry `lifetime`, and an already-obtained old view stops at a childless, all-zero `disposed` terminal state without retaining the Application.

Public handles and the top-level Application / Platform are frozen narrow objects. Plain JavaScript inspection of own properties or prototypes will not reveal:

```text
PluginInstallation
GroupNode
ExtensionStore
EventHub
LifetimeHost
ChangeSet host
ChangeSet discard / handle attach / revoke
The Application's Group orchestration port
staged publication methods
Platform Artifact / Core handle
```

TypeScript's `private` is not treated as a security measure; the implementation uses real `#private` fields or separate facade handles to prevent runtime shape leakage.

Context restrictions are not a security sandbox either. A same-realm plugin can still reach `globalThis`, the DOM or fetch. Untrusted plugins must go into a Worker, iframe, restricted realm or separate process.

## 15. Error conventions

Programming-shape errors use `TypeError`. Decidable model errors use `DougongError.code`:

| code | Meaning |
| --- | --- |
| `CONFIG_INVALID` | the Standard Schema rejected the config |
| `CONTRACT_CONFLICT` | one ID serving several kinds |
| `SERVICE_CONFLICT` | a Service has several providers |
| `SERVICE_MISSING` | a required Service has no provider |
| `SERVICE_CYCLE` | a Service dependency cycle or self-dependency |
| `SERVICE_NOT_RETURNED` | setup did not return a declared output |
| `SERVICE_UNAVAILABLE` | an external read or a runtime binding is currently unavailable |
| `PLUGIN_REMOVED` | an operation on an instance already removed from the plan |
| `PLUGIN_UNAVAILABLE` | the handle cannot enter an awaitable state |
| `PLUGIN_IDENTITY` | update attempted to change the plugin name |
| `GROUP_REMOVED` | an operation on a removed Group |
| `GROUP_UNAVAILABLE` | the Group has not been successfully established |

Because an Event by definition collects every listener failure, it always throws an `AggregateError`. Lifetime and shutdown attempt every resource first: a single failure is rethrown as-is, and multiple failures aggregate. A rollback or fail-closed spanning several phases uses `AggregateError` uniformly.

Errors from background tasks, subscribers and later observes cannot return to the original synchronous stack and are reported through `onError`. A failure inside `onError` itself must not change the runtime command being observed.

## 16. Forbidden directions

- plugin base classes and framework inheritance trees
- decorator dependency injection and string service locators
- proxy contexts, prototype-chain shadowing, live Service proxies
- signals/effects, React, HTTP, Node, filesystem or timers built into Core
- domain policies such as `extension.keyed/many/ordered/override` entering Core
- conflating scope with Group
- a lifecycle hook matrix
- adding serial/bail/waterfall query modes to Event
- plugins arbitrarily mutating the global plugin graph
- loaders, manifests, HMR or permissions entering Core
- passing context API restrictions off as a security sandbox
- fields or methods hidden only in type declarations but leaked on the JavaScript object

## 17. Final criteria

Answer these before any new requirement:

1. Is it a stable capability, an open contribution, a transient fact or a resource?
2. Can it be composed from Service, Extension, Event, Lifetime and ordinary functions?
3. Does it genuinely require changing Core?
4. Does a semantically equivalent entry point already exist at the same layer?
5. Can the higher-level implementation use only public APIs?
6. Does composition preserve the original lifetime, transaction and error semantics?
7. Does it leak an internal registry, host, installation state object or a security illusion?
8. With React, Node, Wails and the reactive package removed, does Core still hold?

The design formula:

```text
Plugin =
  setup(
    immutable service snapshot,
    live extension views,
    config,
    lifetime,
  )
  →
  atomic service outputs
  + owned contributions
  + owned listeners
  + owned resources
```

A user only needs to remember three sentences:

```text
A plugin obtains capabilities through requires, provides Services through return,
and joins open extensions through contribute.

Every listener, contribution, task and cleanup belongs automatically to the
Lifetime that created it.

A Service change rebuilds consumers, an Extension change notifies subscribers,
and an Event only broadcasts this one fact.
```
