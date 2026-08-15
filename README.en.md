<div align="center">

# Dougong

**A capability composition and structured lifetime kernel** · pure JavaScript/TypeScript

[![npm](https://img.shields.io/npm/v/dougong?color=9f3f2f)](https://www.npmjs.com/package/dougong)
[![license](https://img.shields.io/npm/l/dougong?color=9f3f2f)](./LICENSE)
[![node](https://img.shields.io/node/v/dougong?color=9f3f2f)](https://nodejs.org)

[Documentation](https://tangerg.github.io/dougong/en/) ·
[Getting started](https://tangerg.github.io/dougong/en/guide/getting-started) ·
[Core concepts](https://tangerg.github.io/dougong/en/guide/concepts) ·
[API specification](https://tangerg.github.io/dougong/en/reference/core-api) ·
[简体中文](./README.md) · **English**

</div>

---

Dougong (斗拱, the interlocking bracket set of Chinese timber architecture) solves one problem: **when an application's capabilities must be split into independently installable units, how do their dependencies, lifetimes and changes stay reasonable about?**

```sh
npm install dougong
```

```ts
import { createApp, definePlugin, service } from "dougong"

const CLOCK = service<Clock>("app/clock")

const clock = definePlugin({
  name: "app.clock",
  provides: { clock: CLOCK },
  setup: () => ({ clock: { now: () => new Date() } }),
})

const greeter = definePlugin({
  name: "app.greeter",
  requires: { clock: CLOCK },        // the dependency lives here
  setup(ctx) {
    console.log(ctx.clock.now())     // only declared dependencies exist, or it fails to compile
  },
})

const app = createApp({ name: "hello" })
app.install(greeter)                 // install order does not decide start order
app.install(clock)
await app.start()                    // topology derived from declarations, layers start concurrently
```

## Why it looks like this

**Explicit over implicit.** Dependencies live in `requires`, identity lives in Contracts, ownership lives in Lifetimes, runtime selection lives in ordinary parameters. No service locator, ambient scope, prototype-chain injection or proxy — where `ctx.foo` comes from is always visible in the same file.

**One semantic, one path.** Every semantic operation has exactly one canonical entry point, and higher-level convenience must expand mechanically onto it rather than owning a second state machine.

| Semantic | Entry point | | Semantic | Entry point |
| --- | --- | --- | --- | --- |
| Install a plugin | `install()` | | Listen / emit an Event | `on()` / `emit()` |
| Atomic plan change | `change()` | | Register a resource | `cleanup()` |
| Publish a Service | `provides` + `setup` return | | Child lifetime / task | `lifetime(label)` / `spawn()` |
| Contribute to an Extension | `contribute()` | | Read / subscribe to a live value | `get()` / `subscribe()` |
| Update / remove an installation | `update()` / `remove()` | | Release a resource early | `dispose()` |

**Transactions expose only committed state.** Contract kinds, listeners and contributions made during setup stay staged until the whole layer validates. A failed change rolls back, and fails closed when it cannot roll back reliably — never a half-built runtime.

**Types are the constraint.** Using an undeclared dependency, reading an Extension as a Service, declaring `provides` without returning it — all compile errors.

## Six atoms

```text
Service      a stable one-to-one capability, fixed per instance;
             a provider change rebuilds consumers
Extension    an open contribution set that adds and removes live,
             notifying subscribers
Event        a transient fact retaining no state, with one dispatch semantic
Lifetime     structured ownership of listeners, contributions, tasks and
             resources; terminal items detach automatically
Plugin       one setup producing a set of capabilities
Application  dependency graph, transactions and instance orchestration
```

A signal is not a fifth capability. `@dougongjs/reactive` provides `signal()` / `computed()` / `batch()` and an `observe()` built on the public Lifetime protocol; Core neither depends on it nor offers implicit effects.

## Packages

| Package | Role | Runtime dependencies |
| --- | --- | --- |
| [`dougong`](./packages/dougong) | Facade re-exporting the three below | the three internal packages |
| [`@dougongjs/core`](./packages/core) | The six atoms, dependency graph, transactions, Groups, diagnostics | `@standard-schema/spec` |
| [`@dougongjs/reactive`](./packages/reactive) | Signal value layer and `observe()` | **none** |
| [`@dougongjs/platform`](./packages/platform) | Manifests, loaders, permissions, lazy activation, HMR | core, zod, compare-versions |

`core` and `reactive` are mutually independent foundations; `platform` depends only on `core`; `dougong` is just the composition entry point. That direction is enforced by an architecture gate in CI.

## When it fits

| Fits | Does not fit |
| --- | --- |
| Capabilities install, update and roll back at runtime | You just need a small DI container |
| Plugins have real dependencies on each other | Plugins are fully independent |
| A half-loaded state is unacceptable | A long-running service where partial degradation beats consistency |
| Desktop apps, editor kernels, build toolchains | A simple web page |

Dougong's failure model is **transactional** — a plugin whose setup fails rolls the whole change back. If you value isolation ("one plugin dying must not affect the others") more, something like [cordis](https://github.com/cordiverse/cordis) fits better. A product trade-off, not a quality ranking.

## Documentation

Three layers, from first run to specification:

**Get running** — [Getting started](https://tangerg.github.io/dougong/en/guide/getting-started) · [Core concepts](https://tangerg.github.io/dougong/en/guide/concepts)

**Go deeper** — [Writing plugins](https://tangerg.github.io/dougong/en/guide/writing-plugins) · [Lifetime and resources](https://tangerg.github.io/dougong/en/guide/lifetime) · [Transactions and change](https://tangerg.github.io/dougong/en/guide/transactions) · [Reactive and observation](https://tangerg.github.io/dougong/en/guide/reactive) · [External plugin delivery](https://tangerg.github.io/dougong/en/guide/platform)

**Specification** — [Core API](https://tangerg.github.io/dougong/en/reference/core-api) · [Architecture](https://tangerg.github.io/dougong/en/reference/architecture) · [Platform](https://tangerg.github.io/dougong/en/reference/platform) · [Error codes](https://tangerg.github.io/dougong/en/reference/errors)

## Examples

[Twelve runnable chapters](./packages/examples) climb three stages — atoms, composition, real hosts — from a minimal Service to the Planet / Lynx scenarios, declarative plans and module-graph HMR, all in CI:

```sh
pnpm examples
```

"Each chapter adds exactly one rung" is a test rather than a claim: all twelve declare the concepts they are first to use, and the test concatenates those declarations and compares them to the syllabus for exact equality — a repeat, an inverted order or a chapter that stands still turns CI red.

Chapters 11 and 12 are roughly 200 lines each and implement, using only the public API, what mature frameworks spend thousands of lines on: a declarative config loader and a hot-reload engine. That is a test of whether Core's abstractions are genuinely expandable.

## Requirements

Node.js ≥ 22, or an equivalent ES2024 host (`Promise.withResolvers()` is required).

TypeScript consumers need this in `tsconfig.json`:

```json
"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]
```

## Development

```sh
pnpm install
pnpm check      # the 9-step verification gate
pnpm docs:dev   # the documentation site locally
```

`pnpm check` runs, in order: type check → lint → format check → tests and coverage → dead-code check → circular-dependency check → architecture layer check → release build → documentation build.

Architectural constraints do not live only in prose: `scripts/check-layers.mjs` turns package dependency direction, module ranks and rules such as "Platform must reuse Core's observation protocol" into CI failures.

## Status

Early development (`0.0.x`) with **no backward-compatibility promises yet**. The priority is a correct model, a consistent API and complete executable evidence.

## License

[MIT](./LICENSE)
