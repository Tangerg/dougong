# Writing plugins

This page starts from the smallest possible plugin and adds dependencies, provisions, config validation, optional dependencies and failure handling.

## The smallest form

```ts
import { definePlugin } from "dougong"

const plugin = definePlugin({
  name: "app.hello",
  setup() {
    console.log("started")
  },
})
```

`name` is a required stable identifier. It is used for diagnostics and installation IDs (`app.hello:1`); it plays no part in dependency resolution — that is what Contracts are for.

`definePlugin` preserves the declared Plugin shape for **type inference**, validates `name`, `requires` and `provides`, and returns an immutable normalized declaration. Mistakes therefore surface where the Plugin is written rather than when the Host starts.

## Declaring dependencies

```ts
const DATABASE = service<Database>("app/database")
const ROUTES = extensionPoint<Route>("http/routes")

definePlugin({
  name: "app.users",
  requires: {
    db: DATABASE,      // Service → ctx.db is a Database
    routes: ROUTES,    // ExtensionPoint → ctx.routes is a ContributionView<Route>
  },
  setup(ctx) {
    ctx.db.query("select 1")
    ctx.routes.get()
  },
})
```

The keys in `requires` are **aliases you choose**; they need not match the Contract ID. That lets one plugin require two Services of the same type:

```ts
requires: {
  primary: PRIMARY_DB,
  replica: REPLICA_DB,
}
```

Within one Plugin, a Contract ID may appear only once. If two aliases point at the same Contract, or the same Service appears in both `requires` and `provides`, `definePlugin()` rejects immediately; remove the duplicate alias or declare distinct Contract IDs for capabilities with distinct semantics.

::: tip Reserved names
`ctx` carries a set of built-in members, and aliases may not collide with them: `signal`, `meta`, `log`, `cleanup`, `lifetime`, `spawn`, `on`, `emit`, `contribute`. Using one throws immediately from `definePlugin`.
:::

### Optional dependencies

```ts
import { optional } from "dougong"

definePlugin({
  name: "app.telemetry",
  requires: { tracer: optional(TRACER) },
  setup(ctx) {
    ctx.tracer?.startSpan("boot")   // typed as Tracer | undefined
  },
})
```

With no provider, `ctx.tracer` is `undefined` and the Installation activates normally. If a provider later appears or disappears, its Instance is **rebuilt** — so `ctx.tracer` never changes within one Instance lifetime.

`optional()` accepts only Services. ExtensionPoints do not need it: an empty map is already valid.

## Providing capabilities

```ts
const USERS = service<UserService>("app/users")

definePlugin({
  name: "app.users",
  requires: { db: DATABASE },
  provides: { users: USERS },
  setup(ctx) {
    return {
      users: createUserService(ctx.db),   // keys must match provides
    }
  },
})
```

Every key in `provides` must appear in the return value; a missing one is `SERVICE_NOT_RETURNED`. This is caught at **compile time**:

```ts
provides: { users: USERS },
setup() {},        // ❌ Type '() => void' is not assignable to
                   //    '(context, config) => Awaitable<ProvidedServices<...>>'
```

Two Plugin declarations providing the same Contract throw `SERVICE_CONFLICT` while the graph is built — before any Instance starts.

## Contributing to an ExtensionPoint

```ts
definePlugin({
  name: "app.user-routes",
  setup(ctx) {
    ctx.contribute(ROUTES, "users.list", { path: "/users", run: listUsers })
    ctx.contribute(ROUTES, "users.show", { path: "/users/:id", run: showUser })
  },
})
```

The second argument is a **local key**, unique only within the current Instance. Core composes the real key:

```text
<escaped installation id>/<escaped local key>
```

where `%` and `/` become `%25` and `%2F`. So different plugins may reuse the same local key, and no two distinct (installation, key) pairs can ever collide.

The returned `Contribution` supports update and early withdrawal:

```ts
const c = ctx.contribute(ROUTES, "users.list", route)
c.update(nextRoute)   // update in place, notifying subscribers
c.dispose()           // withdraw early
```

Not calling `dispose()` is fine — every contribution is withdrawn when the Instance stops.

## Configuration and validation

`config` accepts any [Standard Schema](https://github.com/standard-schema/standard-schema) implementation (Zod, Valibot, ArkType, …):

```ts
import { z } from "zod"

const schema = z.object({
  hostname: z.string(),
  port: z.number().default(5432),
})

const db = definePlugin({
  name: "app.db",
  config: schema,
  provides: { db: DATABASE },
  setup(ctx, config) {
    //             ^ the schema **output** type; port is always present
    return { db: connect(config.hostname, config.port) }
  },
})

host.install(db, { hostname: "localhost" })   // the input type; port may be omitted
```

Input and output are two distinct types: `host.install()` accepts the **input** (`port` optional), while `setup` receives the **output** (`port` defaulted).

Validation failure throws `ConfigValidationError` (code `CONFIG_INVALID`) carrying an `issues` array:

```ts
try {
  await installation.ready()
} catch (e) {
  if (e instanceof ConfigValidationError) {
    e.issues.forEach((i) => console.error(i.path, i.message))
  }
}
```

**Every affected Installation's Plugin config is validated before any running Instance is stopped.** One bad config never leaves your application halfway down.

## Asynchronous setup

```ts
definePlugin({
  name: "app.db",
  provides: { db: DATABASE },
  async setup(ctx) {
    const client = await connect()
    ctx.cleanup(() => client.close())
    return { db: client }
  },
})
```

Installations in the same topological layer run setup **concurrently**. During startup, `ctx.signal` aborts if any setup in that layer fails, so slow work can be cancelled:

```ts
async setup(ctx) {
  const client = await connect({ signal: ctx.signal })
  ...
}
```

## What failure does

When setup throws:

1. Every resource the Instance already acquired is **released** (cleanups run in reverse)
2. Its staged listeners, contributions and Contract kinds are **never published**
3. `ctx.signal` aborts for the other Instances in the same layer
4. The whole change **rolls back** to the previous execution graph
5. `installation.ready()` rejects and `installation.status` becomes `"failed"`
6. `host.status` returns to its pre-change value — it never stops in an intermediate state

```ts
const installation = host.install(brokenPlugin)
await expect(installation.ready()).rejects.toThrow("setup failed")
expect(host.status).toBe("active")     // other Installations are untouched
```

Throwing a non-`Error` value (`throw "boom"`) is classified as a `DougongError` with code `INSTALLATION_UNAVAILABLE`, keeping the original value in `cause` — so `undefined` never means both "the failure value" and "no failure".

## Update and remove

```ts
const installation = host.install(plugin, { hostname: "a" })

await installation.update({ config: { hostname: "b" } })   // swap config
await installation.update({ plugin: nextVersion })     // swap declaration, keep Installation identity
await installation.remove()
```

An update preserves **Installation identity**: the ID, the position in diagnostics and the Group membership all stay. The active Instance is replaced, and only the affected dependency closure restarts; unrelated Installations are untouched.

```ts
installation.id        // "app.db:1"
installation.status    // "pending" | "active" | "stopping" | "failed" | "removed"
installation.groupId   // the owning Group's ID
await installation.ready()   // resolve when this installation is ready; reject on failure
```

## A complete example

```ts
import { createHost, definePlugin, extensionPoint, optional, service } from "dougong"
import { z } from "zod"

const DATABASE = service<Database>("app/database")
const METRICS = service<Metrics>("app/metrics")
const ROUTES = extensionPoint<Route>("http/routes")

const database = definePlugin({
  name: "app.database",
  config: z.object({ url: z.string(), poolSize: z.number().default(10) }),
  provides: { db: DATABASE },
  async setup(ctx, config) {
    const client = await createPool(config.url, config.poolSize)
    ctx.cleanup(() => client.end())
    ctx.log.info("database connected")
    return { db: client }
  },
})

const users = definePlugin({
  name: "app.users",
  requires: { db: DATABASE, metrics: optional(METRICS) },
  setup(ctx) {
    ctx.contribute(ROUTES, "list", {
      path: "/users",
      run: async () => {
        ctx.metrics?.count("users.list")
        return ctx.db.query("select * from users")
      },
    })
  },
})

const host = createHost({ name: "api" })
host.install(users)
host.install(database, { url: process.env.DATABASE_URL! })
await host.start()
```

## Next

- [Lifetime and resources](./lifetime.md) — the full rules for `cleanup` / `spawn` / `lifetime`
- [Transactions and change](./transactions.md) — changing several plugins atomically
- [Core API specification](../reference/core-api.md) — edge cases for every API
