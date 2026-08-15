# Transactions and change

A running application needs to install plugins, remove them and swap configuration. Dougong's guarantee is:

> **Transactions expose only committed state.** A change either takes effect entirely, or the runtime graph returns to what it was — never a half-built runtime.

## A single change

```ts
const handle = app.install(plugin, config)   // returns immediately
await handle.ready()                         // await this installation becoming ready

await handle.update({ config: nextConfig })
await handle.remove()
```

Before `app.start()`, `install()` only records a declaration. After it, the call runs a runtime transaction.

## Atomic multi-plugin change: ChangeSet

When several operations must **succeed or fail together**, use `change()`:

```ts
const changes = app.change()
changes.install(newProvider)
changes.update(oldHandle, { plugin: nextVersion })
changes.remove(deprecatedHandle)
await changes.commit()          // one transaction
```

This is the **canonical** entry point for multi-plugin change. `install()` / `update()` / `remove()` are its single-item degenerate forms — they run the same path internally and own no second state machine.

Properties:

- **One-shot** — no modification after `commit()`; calling it again returns the same promise
- **One operation per installation** — the same handle cannot be both updated and removed in one ChangeSet
- **Nothing before commit** — an abandoned draft never touches the runtime

## What failure does

Dougong has three levels of failure handling, in increasing severity.

### 1. Rollback

The new graph cannot start → restore the previous graph; `app.status` returns to `active`.

```ts
const changes = app.change()
changes.install(brokenPlugin)
await expect(changes.commit()).rejects.toThrow("setup failed")

expect(app.status).toBe("active")     // other plugins are entirely unaffected
```

### 2. Fail closed

The old graph **also** cannot be restored (say a plugin's cleanup threw, so whether its resources were released is unknown) → do not pretend to be healthy. Stop the Application at `idle` and throw an error aggregating every cause.

Better for the host to see "I stopped, and here is why" than to be handed a runtime that may be damaged.

### 3. Aggregated reporting

Multiple failures during shutdown aggregate into an `AggregateError` with every cause retained. No error is ever silently swallowed.

### Validation precedes shutdown

**Every affected plugin's config is validated before any running instance is stopped.**

```ts
const changes = app.change()
changes.update(a, { config: validConfig })
changes.update(b, { config: invalidConfig })   // this one fails validation
await expect(changes.commit()).rejects.toMatchObject({ code: "CONFIG_INVALID" })

// Neither a nor b was ever stopped — the runtime graph did not move
```

A misspelled config field never leaves your application halfway down.

## Incremental restart

A change does not restart the whole application. Dougong computes the **affected closure**: the changed installations plus their transitive dependents, unioned over **both the old and the new** graph.

```text
A ← B ← C        update B
D ← E            E is unrelated to B

Affected: B, C     Untouched: A, D, E
```

Unrelated plugins are never stopped; their Service instances, Lifetimes and background tasks survive intact.

## The startup model

`app.start()` has four steps:

1. **Build the graph** — derive dependencies from `requires` / `provides`, detect cycles and duplicate providers
2. **Validate** — every config through its Standard Schema
3. **Start layers concurrently** — plugins in the same topological layer set up in parallel
4. **Commit the layer** — only after every Service output in that layer validates are Services registered and staged listeners and contributions published

Step 4 is what "transactions expose only committed state" means at startup: listeners and contributions registered during setup are **staged**, and if any plugin in the layer fails, not one of them is published.

```text
Observable result of a failed prepare, for that layer:

Published Services         0
Published contributions    0
Published listeners        0
Registered Contract kinds  0
Acquired resources         all release attempted
```

### Graph-time errors

These are thrown **before any plugin starts**:

| Code | Condition |
| --- | --- |
| `SERVICE_CYCLE` | dependency cycle; the message carries the real path |
| `SERVICE_CONFLICT` | two plugins provide the same Service |
| `SERVICE_MISSING` | a required Service has no provider |
| `CONTRACT_CONFLICT` | one ID used as two kinds |

Cycle detection reports the actual path, not "everything that failed to sort":

```text
Plugin dependency cycle: app.a:1 -> app.b:2 -> app.a:1
```

## Group: an installation ownership tree

A Group manages a set of plugins as one unit:

```ts
const feature = app.group("editor", (plugins) => {
  plugins.install(syntax)
  plugins.install(formatter)

  plugins.group("lsp", (nested) => {      // nesting is allowed
    nested.install(languageServer)
  })
})

await feature.ready()      // await the whole subtree
feature.status             // aggregated status
await feature.remove()     // remove the whole subtree
```

The `configure` callback **must be synchronous** (returning a promise throws), because the entire Group's content is committed as one ChangeSet.

A Group can also run its own transaction:

```ts
const changes = feature.change()   // scoped to installations inside this subtree
changes.install(extra)
await changes.commit()
```

### A Group changes no visibility

::: warning The most common misreading
A Group expresses **installation ownership only**. It is not a capability scope, not a provider shadow tree, not a permission boundary and not a security sandbox.

Service resolution and Extension/Event visibility are always **application-wide**. Putting a plugin inside a Group does not make it "see only" what is in that Group.
:::

So how do you get those things:

| Need | The right tool |
| --- | --- |
| Several instances of the same shape (a store per workspace) | An explicit Contract family: ``service<Store>(`app/ws/${id}/store`)`` |
| Runtime tenant selection | An ordinary method parameter: `store.forTenant(id)` |
| Security isolation | A separate Application, Worker, iframe or process — a real boundary |

### An established Group is not poisoned by failure

```ts
const group = app.group("stable", (p) => p.install(good))
await group.ready()

const changes = group.change()
changes.install(broken)
await expect(changes.commit()).rejects.toThrow()

expect(group.status).toBe("active")            // still healthy
await expect(group.ready()).resolves.toBeUndefined()
```

A Group that has been established at least once keeps presenting its last committed state after a change that rolled back completely. A Group that never established (its first commit failed) stays `failed`.

## Observing state

```ts
app.status
// "idle" | "starting" | "active" | "changing" | "stopping"

app.diagnostics.get()
// { name, status, plugins: ReadonlyMap<string, PluginSnapshot>, groups, ... }

app.diagnostics.subscribe(() => render())
```

The `changing` status exists for a reason: while a runtime transaction is in flight the host's read window is closed — `app.get()` throws `SERVICE_UNAVAILABLE` rather than handing you an intermediate state that is being replaced.

## Next

- [Reactive and observation](./reactive.md) — driving Lifetime rebuilds from a signal
- [External plugin delivery](./platform.md) — manifests, permissions, lazy activation
- [Core API specification](../reference/core-api.md) — exact semantics and edge cases
