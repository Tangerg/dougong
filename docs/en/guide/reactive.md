# Reactive and observation

`@dougongjs/reactive` is a **zero-dependency** value layer providing `signal` / `computed` / `batch` and one combinator, `observe`.

It and Core are **mutually independent**. This page explains what that decision means and how to use the package.

## Why a signal is not a fifth capability

Core has three Contract kinds: Service, Extension and Event. The natural question is why there is no fourth, `signal<T>()`.

Because **a signal is a way of representing a value, not a way of organising a capability**.

A Service can return a signal; an Extension's values can be signals:

```ts
const THEME = service<{ current: ReadonlySignal<Theme> }>("app/theme")
```

If "signal" were also a Contract kind, then "should the theme capability be a Service or a Signal?" would be a question with no correct answer — both would work, both would appear in the same codebase, and their dependency, transaction and diagnostic semantics would all differ.

**One semantic has one canonical entry point.** Capabilities are organised through Service / Extension / Event; whether the value one returns happens to be reactive is the plugin's own implementation detail.

For the same reason Core offers no implicit effects. Where a side effect belongs must be written on a Lifetime, never inferred from "who is currently reading me".

## The value layer

```ts
import { signal, computed, batch } from "dougong"

const count = signal(0)
const double = computed(() => count.get() * 2)

count.get()      // 0
double.get()     // 0

count.set(21)
double.get()     // 42
```

`computed` is **lazy**: with no subscribers it does not recompute eagerly; it evaluates on demand at `get()` and caches. Dependencies are **tracked dynamically** — collected fresh on each evaluation, so a signal in a branch that was not taken does not become a dependency.

```ts
const a = signal(1), b = signal(2), useA = signal(true)
const value = computed(() => (useA.get() ? a.get() : b.get()))
// while useA is true, changes to b never invalidate value
```

### batch

```ts
batch(() => {
  first.set(1)
  second.set(2)
})   // subscribers are notified once
```

`batch` coalesces every notification inside the callback. Nested batches flush only when the outermost one ends.

::: warning All three entry points reject async callbacks
```ts
batch(async () => { ... })            // ✗ TypeError: Reactive batches must be synchronous
computed(async () => { ... })         // ✗ TypeError: Computed signal calculations must be synchronous
observe(source, async () => { ... })  // ✗ TypeError: Observers must be synchronous
```

Synchronous tracking and batch boundaries cannot survive an `await` — once they do, dependency collection captures the wrong set and the batch flushes before the async work finishes. Rather than produce a silently wrong result, these throw immediately.

Asynchronous work belongs in `lifetime.spawn()`.
:::

### Subscribing

```ts
const subscription = count.subscribe(() => console.log("changed"))
subscription.dispose()
```

Both `Signal` and `ReadonlySignal` implement the structural `Readable<T>` protocol:

```ts
interface Readable<T> {
  get(): T
  subscribe(listener: () => void): Disposable
}
```

Core's `ExtensionView` and `diagnostics` use the **same protocol**, so any observation source can be consumed the same way — no adapters.

## observe: compiling value change into resource rebuild

`observe()` is the only part of this package that touches Lifetimes, and it is a **free function** over structural protocols:

```ts
import { observe } from "dougong"

observe(source, owner, (value, lifetime) => {
  // On each change: release the previous lifetime, then build a new one from the new value
})
```

Three parameters:

- `source` — any `Readable<T>`: a signal, an `ExtensionView`, `diagnostics`, or your own object
- `owner` — anything providing `cleanup` / `lifetime` / `spawn`; a plugin's `ctx` fits exactly
- `observer` — receives the current value and a dedicated child Lifetime

### A typical use

```ts
const CURRENT_TRACK = service<Readable<Track | undefined>>("player/current")

definePlugin({
  name: "player.audio",
  requires: { current: CURRENT_TRACK },
  setup(ctx) {
    observe(ctx.current, ctx, (track, lifetime) => {
      if (!track) return

      const element = new Audio(track.url)
      lifetime.cleanup(() => {
        element.pause()
        element.src = ""
      })

      lifetime.spawn(async (signal) => {
        await waitForCanPlay(element, signal)
        await element.play()
      })
    })
  },
})
```

Each time `current` changes, Dougong will:

1. release the previous `lifetime` (pausing and clearing the old audio element, aborting the old task)
2. create a new child Lifetime for the new value
3. release both the last child and the observation itself when the plugin stops

You never write "check whether there is a previous one, and if so clean it up first" — **release the old, build the new** is what `observe` means.

### Why it is a free function

`observe` does not live in Core, and Core does not know it exists. It relies on structural typing:

```ts
interface ObservationOwner {
  cleanup(fn): Disposable
  lifetime(label): ObservationLifetime
  spawn(fn): ObservationTask
}
```

A plugin's `ctx` happens to satisfy that shape, so `observe(source, ctx, ...)` just works — by **structural match**, not inheritance or registration.

The result is a dependency direction that stays one-way: `reactive` does not depend on `core`, and `core` does not depend on `reactive`. You can use either alone.

## Failure handling

`observe` has explicit error semantics:

- the observer throws → reported through the owner's task result; the observation stays alive and retries on the next change
- releasing the previous child Lifetime fails → the observation **stops permanently** and releases its subscription, because whether the old resources were released cannot be confirmed
- a change arrives while the previous one is still being handled → coalesced into a single rebuild with the latest value

## Two observation sources

Core produces `Readable` in two places:

```ts
// Extension view — collection change
ctx.routes.get()                    // ReadonlyMap<string, Route>
ctx.routes.subscribe(() => ...)

// Diagnostics — runtime state
app.diagnostics.get()
app.diagnostics.subscribe(() => ...)

// A plugin's Lifetime ownership tree
snapshot.plugins.get(id)?.lifetime.get()
```

Both feed straight into `observe()`:

```ts
observe(ctx.routes, ctx, (routes, lifetime) => {
  const router = buildRouter(routes)
  lifetime.cleanup(() => router.close())
})
```

The router is rebuilt whenever the route set changes, and the old one closes automatically.

## Relationship to UI frameworks

Dougong binds to no UI framework. React, Vue and Solid all have mature reactivity, and `@dougongjs/reactive` does not try to replace them.

It exists because **Core needs an observation protocol that does not depend on a UI framework**, to express facts like "the collection changed" or "diagnostics changed". If your host is a React app, bridge with `useSyncExternalStore`:

```ts
const routes = useSyncExternalStore(
  (cb) => { const s = view.subscribe(cb); return () => s.dispose() },
  () => view.get(),
)
```

The `get` / `subscribe` protocol is exactly the shape `useSyncExternalStore` wants.

## Next

- [External plugin delivery](./platform.md) — manifests, permissions, lazy activation, HMR
- [Core API specification](../reference/core-api.md) — the unified observation protocol in full
- [Runnable example 04](../examples.md#stage-1) — signals, observe and explicit resource rebuild end to end
