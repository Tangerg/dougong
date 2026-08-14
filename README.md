# Dougong

Dougong is a small, composable application runtime for JavaScript and TypeScript.

It is built around five ideas:

- **Service** — a stable capability supplied by one plugin.
- **Extension** — a live collection of contributions owned by plugins.
- **Event** — a transient fact broadcast without retained state.
- **Signal** — a current value with composable derived values.
- **Lifetime** — explicit ownership for listeners, tasks, contributions, and cleanup.

Plugins receive declared capabilities, return declared services, and contribute to open extensions. There are no decorators, context proxies, base classes, dependency arrays, or lifecycle hook matrices.

The core follows one rule: one semantic has one canonical API. Higher-level packages may add domain vocabulary, but must compile it to these primitives instead of introducing a second runtime path.

## Workspace

```text
packages/
  reactive/   Signal, computed, batch, and the observable protocol
  core/       Contracts, plugins, lifetimes, and application orchestration
  dougong/    Public facade package
```

## Example

```ts
import {
  createApp,
  definePlugin,
  extension,
  service,
} from "dougong"

const DATABASE = service<{ query(sql: string): Promise<unknown> }>("app/database")
const ROUTES = extension<{ path: string; run(): unknown }>("http/routes")

const database = definePlugin({
  name: "app.database",
  provides: { database: DATABASE },
  setup(ctx) {
    const client = createDatabaseClient()
    ctx.cleanup(() => client.close())
    return { database: client }
  },
})

const users = definePlugin({
  name: "app.users",
  requires: { database: DATABASE },
  setup(ctx) {
    ctx.contribute(ROUTES, "users.list", {
      path: "/users",
      run: () => ctx.database.query("select * from users"),
    })
  },
})

const app = createApp({ name: "example" })
app.install(users)
app.install(database)

await app.start()
```

The provider may be installed after its consumer: Dougong derives startup order from declared services. Shutdown always runs in reverse dependency order.

## Runtime semantics

- Plugin definitions are immutable declarations; active plugin instances own a separate resolved config and `Lifetime`.
- Install, update, remove, start, and stop are linearized through one command queue.
- An active change restarts only the changed plugin and the transitive service dependents affected in the old or new dependency graph.
- Configs for the affected graph are validated before running instances are stopped.
- A failed change disposes its partial runtime and restores the previous affected graph. If cleanup or restoration is incomplete, the whole app fails closed to `idle` instead of claiming to be healthy.
- `ctx.emit()` has one meaning: listeners run in parallel, the call awaits all of them, and failures are aggregated. Use `ctx.spawn(() => ctx.emit(...))` when the emission is intentionally background work.
- `ctx.cleanup()` runs in LIFO order. A lifetime moves through `active → disposing → disposed`; cleanup may still emit events while it is disposing, but cannot acquire new owned resources.
- `computed()` only auto-tracks Dougong signals. The structural `Readable` protocol is deliberately broader and is accepted by `ctx.observe()` for integration with external stores.

Two documents cover the design. [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) is the
rationale: why the layering is what it is, where the kernel's boundaries are, and how the primitives
map onto desktop, frontend, and backend applications. [docs/api-design.zh-CN.md](docs/api-design.zh-CN.md)
is the specification: what each API does precisely, what it does at every edge, and which deviations
between spec and implementation are currently known.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` is the whole gate, and it is the same command CI runs:

| Step               | Tool               | What it guards                                          |
| ------------------ | ------------------ | ------------------------------------------------------- |
| `typecheck`        | tsc                | each package plus the test project, under strict options |
| `lint`             | oxlint             | correctness and idiom, warnings included                 |
| `format:check`     | prettier           | formatting                                              |
| `test`             | vitest + istanbul  | behaviour, with per-package coverage floors             |
| `knip`             | knip               | unused exports, files, and dependencies                 |
| `check:circular`   | madge              | import cycles, against an allowlist                     |
| `check:layers`     | madge + script     | package and module direction, architecture invariants   |
| `build`            | vite + dts         | the published ESM bundle and declarations               |

Individual steps run on their own (`pnpm lint`, `pnpm test`, …). `pnpm lint:fix` and
`pnpm format` write fixes; `pnpm test:watch` runs the suite without coverage.

A husky pre-commit hook runs prettier and oxlint over staged files only. Set
`HUSKY=0` to skip it.

`scripts/check-layers.mjs` encodes the dependency direction
(`reactive ← core ← dougong`, and a strict module order inside `core`) plus the
architecture invariants that the type system cannot express — no Node built-ins,
no ambient clock or entropy, no direct `console` calls, and `Lifetime`
construction confined to the orchestrator. Moving a boundary means editing the
table there with a reason.
