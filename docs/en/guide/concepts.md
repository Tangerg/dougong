# Core concepts

Dougong's model is six atoms. They are **orthogonal** — each solves one thing, and none can substitute for another. This page explains the question each atom answers, plus the distinctions people most often confuse.

## The map

| Atom | In one line | The question it answers |
| --- | --- | --- |
| **Contract** | A frozen identity token | "What is this capability called, and what type is it" |
| **Service** | A stable one-to-one capability | "Who provides the database connection" |
| **ExtensionPoint** | An open contribution set | "Which routes / commands / themes exist" |
| **Event** | A transient fact | "What just happened" |
| **Lifetime** | Structured ownership | "Who owns this resource, and when is it released" |
| **Plugin** | One setup producing a set of capabilities | "What is this unit of functionality" |
| **Host** | Graph + transactions + orchestration | "How do these units become one execution system" |

## Contract: identity before implementation

A Contract is a frozen `{ id, kind }` object binding a **string ID** to a **TypeScript type**:

```ts
import { service, extensionPoint, event } from "dougong"

const DATABASE = service<Database>("app/database")
const ROUTES = extensionPoint<Route>("http/routes")
const USER_CREATED = event<User>("users/created")
```

The three kinds correspond to the three capability semantics. One ID cannot serve **two kinds** in the same Host; doing so throws `CONTRACT_CONFLICT`.

Contracts hold no execution state, are reusable across Hosts, and should be exported **once** from a stable module:

```ts
export const DATABASE = service<Database>("app/database")
```

::: warning One thing TypeScript cannot catch
Two modules can write different type arguments for the same ID:

In `a.ts`:

```ts
export const FOO = service<Logger>("app/foo")
```

In `b.ts`:

```ts
export const FOO = service<Database>("app/foo")
```

TypeScript alone cannot prevent this, and a same-kind conflict cannot be recovered from erased generics at execution time — consumers silently receive the wrong type. **A fixed Contract ID should be declared exactly once and exported from a stable module.** Dougong's architecture guard rejects duplicate fixed-string declarations in this repository; codebases using Dougong should enforce the same static rule. Parameterized IDs created by a Contract family are not duplicate fixed declarations.
:::

## Service vs ExtensionPoint: one-to-one vs many-to-many

This is the most common decision. There is a single criterion: **does this capability have one provider, or arbitrarily many?**

```ts
const DATABASE = service<Database>("app/database")

const ROUTES = extensionPoint<Route>("http/routes")
```

How they differ in use:

```ts
definePlugin({
  name: "app.db",
  provides: { db: DATABASE },
  setup: () => ({ db: createClient() }),
})

definePlugin({
  name: "app.db-consumer",
  requires: { db: DATABASE },
  setup: (ctx) => { ctx.db.query("...") },
})

definePlugin({
  name: "app.routes",
  setup(ctx) {
    const c = ctx.contribute(ROUTES, "users.list", { path: "/users", run })
    c.update({ path: "/users", run: newRun })
    c.dispose()
  },
})

definePlugin({
  name: "app.router",
  requires: { routes: ROUTES },
  setup(ctx) {
    ctx.routes.get()
    ctx.routes.subscribe(() => rebuildRouter())
  },
})
```

The essential differences:

| | Service | ExtensionPoint |
| --- | --- | --- |
| Providers | exactly 1 | 0..n |
| Consumers receive | an implementation **fixed** for the Instance | a **live** view: `get()` / `subscribe()` |
| When the provider changes | the consumer is **rebuilt** | the consumer is notified, not rebuilt |
| When absent | `SERVICE_MISSING` (unless `optional()`) | an empty map is a valid value |

That last row explains why `optional()` only accepts a Service: an empty ExtensionPoint is already a valid state, so "optional" adds nothing.

### Why the Service snapshot is fixed

The `ctx.db` a consumer receives is the **same object** for the whole Instance lifetime — not a live proxy. If the provider is updated or removed, Dougong **rebuilds the consumer Instance** (stops it, then starts it again) rather than quietly swapping the reference it holds.

That is what makes this safe:

```ts
setup(ctx) {
  const db = ctx.db
  ctx.spawn(async () => { db.query() })
}
```

The cost is a larger blast radius when a provider changes (its dependent closure restarts); the benefit is that plugin internals need no defensive re-reads.

## Event: something that already happened

An Event is **transient** — no retained state, no notion of a provider, and late subscribers do not receive history.

```ts
definePlugin({
  name: "app.welcome",
  setup(ctx) {
    ctx.on(USER_CREATED, (user) => sendWelcomeMail(user))
  },
})

definePlugin({
  name: "app.user-events",
  async setup(ctx) {
    await ctx.emit(USER_CREATED, user)
  },
})
```

`emit()` returns a Promise and awaits all listeners. A closed Lifetime, an invalid Contract and listener failures all become promise rejections, so `void ctx.emit(EVENT, value).catch(report)` reliably handles every emission failure. An `Event<void>` can be emitted as `ctx.emit(READY)`.

There is exactly one dispatch mode — no `parallel` / `serial` / `bail` / `waterfall` decision to get wrong. Need to collect return values? That is not Event semantics; use an ExtensionPoint.

### Choosing between the three

Ask: **does the consumer need "the current state" or "the fact that something changed"?**

- State, from a single source → **Service**
- State, from an open set of sources → **ExtensionPoint**
- The change itself, with nothing retained → **Event**

A common mistake is shipping state through an Event:

```ts
ctx.emit(CONFIG_CHANGED, newConfig)
```

Configuration is state. It belongs in a Service or an ExtensionPoint. In particular, never use an Event in `setup()` to seed initial state: listeners and contributions stay staged until their startup layer commits, and same-layer setup order is unspecified. Initial state belongs in a Service getter, a Signal exposed by a Service, or the current ExtensionPoint snapshot.

## Lifetime: who owns what

Every Instance has a root Lifetime. Everything acquired during `setup` belongs to that Instance and is **released in reverse order** when the Instance stops.

```ts
async setup(ctx) {
  ctx.cleanup(() => client.close())
  const task = ctx.spawn(async (signal) => {
    await poll(signal)
  })
  const child = ctx.lifetime("connection")
  child.cleanup(() => socket.close())
  await child.dispose()
}
```

The handles returned by `ctx.on()` and `ctx.contribute()` are owned too — you never collect them by hand.

All seven resource kinds (cleanups, tasks, listeners, contributions, contributionViews, subscriptions, childLifetimes) follow **one ownership rule**: early release detaches from the parent, and parent release cleans up every live resource in reverse order, aggregating failures.

See [Lifetime and resources](./lifetime.md).

## Plugin: one setup, a set of capabilities

```ts
const plugin = definePlugin({
  name: "app.users",
  config: UserConfigSchema,
  requires: { db: DATABASE },
  provides: { users: USER_SERVICE },
  setup(ctx, config) {
    return { users: createUserService(ctx.db, config) }
  },
})
```

`setup` may be asynchronous. Its return value must contain every key declared in `provides`, otherwise `SERVICE_NOT_RETURNED`.

**A Plugin is a reusable declaration; an Installation is its stable installed identity; an Instance is one active execution.** The same Plugin can be installed multiple times with different configs. Each Installation has its own ID and owns a fresh Instance and Lifetime whenever active.

## Host: putting it together

```ts
const host = createHost({ name: "my-app" })

const installation = host.install(plugin, config)
await host.start()
host.status
host.get(SOME_SERVICE)
host.diagnostics.get()
await host.stop()
```

A Host owns four things:

1. **The dependency graph** — derived from `requires` / `provides`, detecting cycles (`SERVICE_CYCLE`, reporting the real path) and duplicate providers (`SERVICE_CONFLICT`)
2. **Transactions** — a change either takes effect entirely or rolls back; see [Transactions and change](./transactions.md)
3. **Instance orchestration** — layered concurrent start, reverse-order stop, incremental restart of the affected closure
4. **Diagnostics** — an immutable, subscribable read model of committed execution state

## Why a signal is not on this list

`@dougongjs/reactive` provides `signal()` / `computed()` / `batch()` / `observe()`, but **a signal is not a fifth capability**.

The reason: a signal is a way of **representing a value**, not a way of **organising a capability**. A Service can return a signal; an ExtensionPoint's values can be signals. Making "signal" a fourth Contract kind would turn "should this capability be a Service or a Signal?" into a question with no correct answer.

Core does not depend on reactive, and offers no implicit effects. See [Reactive and observation](./reactive.md).

## A Group is not a scope

`host.group(name, configure)` builds an **installation ownership tree** — for installing, removing and awaiting a set of plugins together.

```ts
const feature = host.group("feature", (group) => {
  group.install(a)
  group.install(b)
})
await feature.ready()
await feature.remove()
```

A Group changes **no** visibility: Service resolution and ExtensionPoint/Event visibility are always **Host-wide**. It is not a capability scope, not a provider shadow tree, not a permission boundary and not a security sandbox.

Need several statically selected variants of one capability? Use an explicit Contract family. Need request-time tenant selection? Use an ordinary method parameter. Need security isolation? Use a Host, Worker, iframe or process — a real isolation boundary.

## Next

- [Writing plugins](./writing-plugins.md) — config validation, optional dependencies, failure and update
- [Lifetime and resources](./lifetime.md) — the ownership rules in full
- [Core API specification](../reference/core-api.md) — edge cases for every API
