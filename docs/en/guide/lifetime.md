# Lifetime and resources

`setup` opens database connections, registers listeners, starts polling tasks and subscribes to collections. Every one of those must be released when the Instance stops — **none missed, none released twice**.

Dougong solves all of it with one concept: **Lifetime**.

## One rule

> Everything `setup` takes from `ctx` belongs to the current Instance's root Lifetime and is released in reverse order when the Instance stops.

You do not collect resources, keep a `dispose` array, or worry about exception paths skipping an entry.

```ts
setup(ctx) {
  const client = createClient()
  ctx.cleanup(() => client.close())      // register a cleanup
  ctx.on(TICK, handler)                  // listener — owned automatically
  ctx.contribute(ROUTES, "a", route)     // contribution — owned automatically
  ctx.spawn(async (signal) => poll(signal))  // task — owned automatically
}
// On stop: tasks abort and are awaited, listeners deregister,
// contributions withdraw, client.close() runs.
```

## Seven kinds, one rule

| Resource | How it is created | What release does |
| --- | --- | --- |
| `cleanups` | `ctx.cleanup(fn)` | runs `fn` in reverse order |
| `tasks` | `ctx.spawn(fn)` | aborts the signal and awaits completion |
| `listeners` | `ctx.on(EVENT, fn)` | deregisters from the event hub |
| `contributions` | `ctx.contribute(EXT, key, v)` | withdraws from the contribution set |
| `contributionViews` | ExtensionPoints in `requires` | closes the view; later reads throw |
| `subscriptions` | `view.subscribe(fn)` | detaches the listener from the store |
| `children` | `ctx.lifetime(label)` | recursively releases the subtree |

They share three properties:

1. **Reverse order** — last acquired, first released, symmetric with acquisition
2. **Every item attempted** — one failing release does not skip the rest; failures aggregate into an `AggregateError`
3. **Terminal detachment** — anything released early is removed from its parent, so a parent owns only what is still alive

Property 3 matters in practice: a long-running plugin that repeatedly creates and releases sub-resources does not accumulate terminal objects proportional to its history.

## Releasing early

Every releasable resource uses the same `dispose()` operation. Synchronous resources implement `Disposable`; resources that must be awaited implement `AsyncDisposable`:

```ts
const subscription = ctx.on(TICK, handler)
subscription.dispose()          // deregister early, nothing else affected

const contribution = ctx.contribute(ROUTES, "a", route)
contribution.dispose()          // withdraw early

const cleanup = ctx.cleanup(fn)
await cleanup.dispose()         // run fn early (exactly once)
```

`dispose()` is **idempotent**: calling it again neither repeats the cleanup nor throws. Stopping the plugin will not run an already-released item a second time.

`using` and `await using` work too (requires `ESNext.Disposable`):

```ts
async function listenDuring(session) {
  using subscription = session.on(TICK, handler)
  await session.emit(TICK)
  // disposed when the function exits
}

async function run(ctx) {
  await using session = ctx.lifetime("session")
  // fully released before the block exits
}
```

## Background tasks

```ts
const task = ctx.spawn(async (signal) => {
  while (!signal.aborted) {
    await poll()
    await delay(1000, { signal })
  }
  return "done"
})

task.result      // Promise<string>
await task.dispose() // abort and await completion
```

`spawn` hands the callback an `AbortSignal`. When the Lifetime is released:

- tasks **still running** are aborted, and the Lifetime awaits them
- tasks that **already settled** are neither aborted nor awaited — they detached from the parent long ago

That distinction matters: a polling plugin that ran a hundred thousand iterations does not abort a hundred thousand completed tasks on shutdown.

Exceptions thrown by tasks are never swallowed; they surface through the Host's error reporting channel (`createHost({ onError })` or the logger). Cancellation covers only `signal.reason` or an explicit `AbortError`; another error raised after cancellation is still reported.

::: warning Abort is cooperative, not pre-emptive
`task.dispose()`, Lifetime release and `host.stop()` all abort first and then wait for the task body to settle. An `AbortSignal` is only a cancellation notification: if a task is awaiting an operation that neither accepts the signal nor returns, shutdown waits forever too. Dougong never silently abandons work that is still owned by a Lifetime.
:::

Prefer passing the signal to an adapter that genuinely supports cancellation. If a third-party operation cannot be cancelled and both its late completion and failure are safe to ignore, application code can make an explicit “abandon the wait” policy:

<<< ../../../packages/examples/src/abandon-on-abort.ts

```ts
ctx.spawn((signal) =>
  abandonOnAbort(signal, () => legacyClient.flush()),
)
```

This code is included directly from the tested example source. An already-aborted signal registers no listener and never calls `start`; cancellation, success and failure all remove the listener. The cancellation check and `start()` run in the same callback, leaving no microtask gap in which cancellation could occur after the check yet still allow the operation to start.

This helper only lets the Dougong Task abandon the **wait**; it does not stop the underlying operation. The rejection handler remains attached and observes a later failure rather than creating an unrelated unhandled rejection. Use it only when late values and failures are safe to ignore and no resource needs releasing. Resource acquisition needs the [late resource handoff recipe](#retired-acquisition) below; work that may mutate disposed state after shutdown needs an adapter that supports cancellation.

## Child lifetimes

When a group of resources must be replaced or released as a unit, use a child Lifetime:

```ts
async setup(ctx) {
  let current: LifetimeContext | undefined

  const connect = async (url: string) => {
    await current?.dispose()                  // fully release the previous group
    const scope = ctx.lifetime(`conn:${url}`) // the label is for diagnostics
    const socket = openSocket(url)
    scope.cleanup(() => socket.close())
    scope.spawn((signal) => readLoop(socket, signal))
    current = scope
  }

  await connect(initialUrl)
}
```

`label` is a required non-empty string used only for diagnostics. It takes no part in lookup or identity, and duplicates among siblings are legal.

A child that is disposed early detaches from its parent; releasing a parent recursively releases every live subtree. No additional cleanup is needed to dispose an already-owned child.

## Retiring a wait and handing off late resources {#retired-acquisition}

Some external operations cannot be cancelled but return resources that must be closed, such as asynchronously opened streams. Replacing a view should let the old generation leave its wait while someone remains responsible for releasing a late result. Simply ignoring the value abandoned by `abandonOnAbort` is insufficient here.

This tested application recipe composes the public Lifetime API; it is not a new Core or facade API. The application explicitly supplies two different owners:

- `generation` owns the wait and resources acquired in time. It stops accepting results on cancellation, and `generation.cleanup()` is registered synchronously before a resource is delivered.
- `operations` owns the underlying operation, late resource disposal and their error reporting. It must be a longer-lived ancestor or an independent Lifetime, never the generation itself or its descendant.

`operations` must remain active until the underlying Task is created. If it has already started disposing, `spawn()` throws `LIFETIME_DISPOSED` synchronously before creating a Task. If the wait has not already been cancelled, the caller's Promise rejects with that error for the caller to handle, rather than returning a `failed` projection.

The code is included directly from the example package, using the same implementation as its regression tests:

<<< ../../../packages/examples/src/retired-acquisition.ts

The underlying Task's result uses the following read-only projection:

| Result | What the caller should do |
| --- | --- |
| `acquired` | The generation already owns the resource; consume it while still eligible to do so |
| `failed` | The operation error has entered the `operations` Host's reporting channel; display failure state without throwing or reporting `error` again |
| `retired` | The underlying task will deliver no resource and any required late disposal has completed |

When the generation is cancelled, the caller's Promise still rejects with `generation.signal.reason`, letting its owning Task finish under the existing cancellation rules. The caller need not wait for the underlying task to return `retired`. Failures of the external operation or late disposal are wrapped in `Error("External resource operation failed", { cause })`, preserving the original error as `cause`. This prevents an adapter error named `AbortError` from being mistaken for cooperative cancellation of the Task when `operations` is eventually stopped. `failed.error` is this already-reported error.

If the underlying Task is created but cancelled before its body begins, it does not call `start()`; a still-active generation receives `retired`. Once an operation starts, `operations` continues to join it and any required late disposal.

For example, place underlying operations and replaceable views in separate child Lifetimes of the same application Lifetime:

```ts
const operations = ctx.lifetime("external-operations")
const generation = ctx.lifetime("view:1")

generation.spawn(async (signal) => {
  const result = await acquireForLifetime(
    generation,
    operations,
    () => legacyClient.openStream(),
    (stream) => stream.close(),
  )
  signal.throwIfAborted()
  if (result.status !== "acquired") return
  await consumeStream(result.value, signal)
})
```

When replacing the view, the application releases only the current generation, then creates its successor:

```ts
await generation.dispose()
const nextGeneration = ctx.lifetime("view:2")
```

This transition can proceed while the old operation is still pending. A late success is closed inside the `operations` Task and never handed to the next generation. Operation failures and late disposer failures are reported by that Task through the existing Host channel. Resources already delivered successfully are released by `generation.cleanup()`, whose failures follow ordinary Lifetime cleanup aggregation. Do not register a late cleanup with a disposed generation or assign late error reporting to it.

::: warning Retiring the wait preserves the final join
`operations` continues to own the underlying work in full. If the operation never settles, `operations.dispose()` and the final `host.stop()` remain pending; the same applies to a late disposer that never finishes. This recipe lets the shorter-lived generation leave first without promising that the application can skip final cleanup. Ordinary `ctx.spawn()`, Task, Lifetime and Host abort + join contracts are unchanged.
:::

The retirement boundary is the generation's signal. Disposing only the waiting Task does not cancel an active generation, so that Task still waits for acquisition to finish or for the generation to retire.

Nothing here cancels remote execution or resends a command. Whether the remote service accepted a command, whether retry is allowed, which generation may commit UI state, serial ordering within a domain identity and concurrency between different identities all remain application decisions. Acquiring a resource does not grant permission to commit UI state; the application must still check its current identity at the commit boundary.

## Three phases

A Lifetime moves through `active` → `disposing` → `disposed`.

Calling `dispose()` synchronously seals the entire owned subtree. Every Context operation closes, including `emit()`. Dougong withdraws all descendant listeners, subscriptions and views before withdrawing contributions, then aborts the signals. Only after these entrances have closed do tasks and descendant Lifetimes drain concurrently; child shutdown starts in reverse creation order. Each Lifetime runs its cleanups after its own tasks and children have settled. A slow parent task cannot leave a child accepting new events. Cleanup only releases resources.

At this boundary `emit()` returns a promise rejected with `LIFETIME_DISPOSED` rather than throwing synchronously. Code intentionally absorbing a shutdown race can therefore write `void ctx.emit(STOPPED).catch(report)`. If a stopped state must remain readable, put it in a Service or Signal rather than a cleanup Event.

## Observing the ownership tree

Diagnostics carry a live Lifetime ownership tree:

```ts
const snapshot = host.diagnostics.get()
const lifetime = snapshot.installations.get(installationId)?.lifetime

lifetime.get()
// {
//   label: "app.users:1",
//   phase: "active",
//   cleanups: 1, tasks: 1, listeners: 2,
//   contributions: 3, contributionViews: 1, subscriptions: 1,
//   children: [
//     { label: "conn:wss://a", phase: "active", tasks: 1, ... }
//   ]
// }

lifetime.subscribe(() => render())   // notified when resources change
```

The snapshot is **recursively frozen plain data** — labels, phases and counts only. It never exposes Lifetime objects, resources, callbacks or stores. Each node counts only what that Lifetime owns **directly**; subtree totals are derived by walking `children`, because the snapshot deliberately keeps no second aggregate state.

It is also a separate subscription source from the Host snapshot, so high-frequency resource churn never rebuilds the whole Host view.

## Nothing is kept alive backwards

An easily overlooked but high-impact property:

> Holding a released resource never keeps a Host, store, callback or payload alive.

Concretely:

- terminal resources clear their references to owner, store, callback and payload
- a terminal Installation keeps only immutable identity data, not the GroupNode
- a detached Group clears its parent link, so a historical Group cannot reach sibling subtrees through the ownership tree
- terminal failures keep a frozen, bounded `RecordedFailure` record with stack text and value-only cause data, without retaining the original Error object or its application payloads
- a historical diagnostic view severs its reporting callback when it closes

Recoverable failed Installations attached to a live Host retain the original Error for `ready()` and retry. Diagnostics always expose `RecordedFailure`. A discarded Installation releases its authority and stores only that record, so later `ready()` calls reject with `RecordedFailure`; it never reconstructs the original class. See the [error record contract](../reference/errors.md#diagnostic-failure-records).

## Common mistakes

**Acquiring resources outside setup**

```ts
setup(ctx) {
  setTimeout(() => {
    ctx.cleanup(() => {})   // ❌ the plugin may already have stopped → throws
  }, 1000)
}
```

To acquire resources from deferred logic, use `ctx.spawn()`, whose signal aborts on release.

**Collecting handles by hand**

```ts
setup(ctx) {
  const disposables = []                      // ❌ unnecessary
  disposables.push(ctx.on(A, f))
  ctx.cleanup(() => disposables.forEach(d => d.dispose()))
}
```

`ctx.on()` is already owned by the Lifetime. Wrapping it only makes release run twice (idempotent, so harmless — but pointless).

## Next

- [Transactions and change](./transactions.md) — atomic multi-Installation change and rollback
- [Reactive and observation](./reactive.md) — how `observe()` composes onto a Lifetime
- [Core API specification](../reference/core-api.md) — exact semantics and edge cases
