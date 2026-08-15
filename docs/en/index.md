---
layout: home
title: Dougong
titleTemplate: false
description: A capability composition and structured lifetime kernel for JavaScript/TypeScript.
hero:
  name: Dougong
  text: Compose an application, don't stack frameworks
  tagline: A small set of orthogonal atoms for capabilities, dependencies, change and resource ownership. No hidden magic.
  actions:
    - theme: brand
      text: Get started
      link: /en/guide/getting-started
    - theme: alt
      text: Core concepts
      link: /en/guide/concepts
    - theme: alt
      text: GitHub
      link: https://github.com/Tangerg/dougong
features:
  - title: Explicit over implicit
    details: Dependencies live in requires, identity lives in Contracts, ownership lives in Lifetimes. No service locator, ambient scope, prototype-chain injection or Proxy — where ctx.foo comes from is always visible in the same file.
  - title: One semantic, one path
    details: Every semantic operation has exactly one canonical entry point. Higher-level convenience must compile mechanically onto it and may not own a second state machine.
  - title: Transactions expose only committed state
    details: Declarations made during setup stay staged until the whole layer validates. A failed change rolls back, and fails closed when it cannot roll back reliably — never a half-built Instance graph.
  - title: Structured resource ownership
    details: Listeners, contributions, tasks and child lifetimes all belong to a Lifetime. Terminal resources detach from their owner, so holding a released resource never keeps a Host alive.
  - title: Types are the constraint
    details: Using an undeclared dependency, reading an ExtensionPoint as a Service, declaring provides without returning it — all compile errors, never late execution surprises.
  - title: No environment lock-in
    details: Core knows nothing about Node, the DOM, React, HTTP, the filesystem or bundlers. Plain objects, functions, Promise, AbortSignal and Disposable.
---

## What Dougong is

Dougong (斗拱, the interlocking bracket set of Chinese timber architecture) solves one problem: **when an application's capabilities must be split into independently installable units, how do their dependencies, lifetimes and changes remain easy to reason about?**

It has two layers:

- **Core** — the capability composition and structured lifetime kernel. Six atoms: Service, ExtensionPoint, Event, Lifetime, Plugin, Host.
- **Platform** — external plugin delivery on top of Core. Manifest validation, permissions, module loading, lazy activation, hot reload.

Plus an **independent** `reactive` package providing a signal value layer and an `observe()` combinator.

```ts
import { createHost, definePlugin, service } from "dougong"

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

const host = createHost({ name: "hello" })
host.install(greeter)                 // install order does not decide start order
host.install(clock)
await host.start()                    // topology derived from declarations, layers start concurrently
```

## When it fits

| Fits | Does not fit |
| --- | --- |
| Capabilities install, update and roll back after startup | You just need a small DI container |
| Plugins have real dependencies on each other | Plugins are fully independent |
| A half-loaded state is unacceptable | A long-running service where one broken module must not stop the rest |
| The application needs an observable execution model | Operational diagnostics do not matter |
| Desktop apps, editor kernels, build toolchains | A simple web page |

That last row deserves a note. Dougong's failure model is **transactional** — a plugin whose setup fails rolls the whole change back. If your scenario values isolation ("one plugin dying must not affect the others") more than consistency, something like [cordis](https://github.com/cordiverse/cordis) fits better. That is a product trade-off, not a quality ranking.

## How to read these docs

Three layers, best read in order:

<div class="vp-doc" style="margin-top: 1rem">

**Layer 1 · Get running**

1. [Getting started](./guide/getting-started.md) — install and run your first composition
2. [Core concepts](./guide/concepts.md) — what each atom solves and why they cannot substitute for each other

**Layer 2 · Go deeper**

3. [Writing plugins](./guide/writing-plugins.md) — dependencies, provisions, config validation, failure
4. [Lifetime and resources](./guide/lifetime.md) — who owns what, and when it is released
5. [Transactions and change](./guide/transactions.md) — ChangeSet, Group, rollback and fail-closed
6. [Reactive and observation](./guide/reactive.md) — why a signal is not a fifth capability
7. [External plugin delivery](./guide/platform.md) — manifests, permissions, lazy activation, HMR

**Layer 3 · Specification**

8. [Core API specification](./reference/core-api.md) — exact semantics and edge cases
9. [Architecture](./reference/architecture.md) — layering, dependency direction and rationale
10. [Platform specification](./reference/platform.md) — the external plugin boundary
11. [Error codes](./reference/errors.md) — stable codes and what triggers them

</div>

If you would rather read code, the [runnable examples](./examples.md) are a twelve-chapter path from a minimal Service to Planet / Lynx / HMR — all of it runs in CI, and "each chapter adds exactly one rung" is itself a test.

## Status

Dougong is in early development (`0.0.x`) and **makes no backward-compatibility promises yet**. The current priority is a correct model, a consistent API and complete executable evidence.

Runtime baseline: Node.js ≥ 22, or an equivalent ES2024 runtime.
