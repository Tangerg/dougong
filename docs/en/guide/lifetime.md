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
task.dispose()   // abort and await completion
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

```ts
function abandonOnAbort<T>(
  signal: AbortSignal,
  start: () => PromiseLike<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }

    void Promise.resolve()
      .then(() => signal.throwIfAborted())
      .then(start)
      .then(
        (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
      )
  })
}

ctx.spawn((signal) =>
  abandonOnAbort(signal, () => legacyClient.flush()),
)
```

This helper only lets the Dougong Task abandon the **wait**; it does not stop the underlying operation. The rejection handler remains attached and observes a later failure rather than creating an unrelated unhandled rejection. Never use this pattern for work that holds exclusive resources, requires cleanup, or may mutate disposed state after shutdown; such work needs a genuinely cancellable adapter.

## Child lifetimes

When a group of resources must be replaced or released as a unit, use a child Lifetime:

```ts
setup(ctx) {
  let current: LifetimeContext | undefined

  const connect = (url: string) => {
    current?.dispose()                        // release the previous group
    const scope = ctx.lifetime(`conn:${url}`) // the label is for diagnostics
    const socket = openSocket(url)
    scope.cleanup(() => socket.close())
    scope.spawn((signal) => readLoop(socket, signal))
    current = scope
  }

  connect(initialUrl)
  ctx.cleanup(() => current?.dispose())
}
```

`label` is a required non-empty string used only for diagnostics. It takes no part in lookup or identity, and duplicates among siblings are legal.

A child that is disposed early detaches from its parent; releasing a parent recursively releases every live subtree.

## Three phases

A Lifetime moves through `active` → `disposing` → `disposed`.

Once `disposing` begins, every Context operation is closed, including `emit()`. Stop order first withdraws listeners, contributions, subscriptions and views, then aborts the `signal`, and only then awaits tasks, child Lifetimes and cleanups. Cleanup releases resources; it is not a second fact-broadcast phase.

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
- **terminal failures keep only a `name` / `message` / `code` data summary** — a JavaScript `Error.stack` can carry the entire orchestration frame that created it, and must not become an invisible ownership edge
- a historical diagnostic view severs its reporting callback when it closes

Failed Installations that remain attached to a live Host keep the original error for diagnostics and retry. Callers awaiting `ready()` always receive the original `Error` too — the summary only affects reads made **after** the Installation has detached from the Host.

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
