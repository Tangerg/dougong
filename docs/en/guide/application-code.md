# Consuming capabilities from application code

A Plugin lives inside the dependency graph: it declares `requires`, and its resources belong to an Instance Lifetime. Application code lives outside the graph: it drives the Host and owns the subscriptions and Installation handles it obtains. The two positions use different public entries while reading the same committed state.

## Reading a Service

While the Host is active, application code uses `get()` to issue commands or read a stable capability:

```ts
await host.start()
host.get(PLAYER).play(track)
```

`get()` throws `SERVICE_UNAVAILABLE` while idle or changing; it never returns a candidate graph or half-rebuilt state. To probe an optional capability, application code keeps the same entry point and the same optionality atom:

```ts
const analyser = host.get(optional(ANALYSER)) // Analyser | undefined
```

A missing required Service still throws; only `optional()` explicitly permits an absent provider. Presence and absence of `Service<void>` both produce `undefined`; dependencies should provide a real port interface or meaningful domain state, never disguise an installation-order hook as `Service<void>` / `Service<true>`.

## Observing an ExtensionPoint

Application code uses `contributions()` to obtain a stable, Host-owned `ContributionView`:

```ts
const commands = host.contributions(COMMANDS)

const render = () => {
  toolbar.replace([...commands.get().values()])
}

const subscription = commands.subscribe(render)
await host.start()
render()

// The caller owns this subscription.
subscription.dispose()
```

The view can be created before startup, keeps its identity across stop/start, and exposes committed snapshots only. Because it has the Host's lifetime, retaining the view intentionally retains the Host observation chain; let both leave scope together. A Plugin still obtains a view owned by its current Lifetime through `requires`; do not generate a bridge Plugin that collects every ExtensionPoint merely so UI code can read contributions.

The Contribution Map key is a Core-generated ownership identity containing the Installation ID, so it changes after reinstall. Domain IDs, ordering weights and permission labels belong in the value:

```ts
interface Command {
  readonly id: string
  readonly order: number
  readonly run: () => void
}

const ordered = [...commands.get().values()].sort(
  (left, right) => left.order - right.order,
)
```

When the domain requires unique IDs, its composer scans values and rejects conflicts explicitly. Core does not bake one domain's uniqueness, ordering or override policy into ExtensionPoint.

## Bridging an Event to UI

An Event is a transient fact between Instances, so Host exposes neither `on()` nor `emit()`. To deliver facts to graph-external UI, write a bridge Plugin that registers a Listener through `ctx.on()` and updates the application's own store or Signal. That Listener then belongs naturally to the bridge Instance's Lifetime. An Event creates no dependency-graph edge; if the bridge depends on a Service's presence or startup order, it must still declare that Service explicitly in `requires`.

Do not seed initial state with an Event during setup. Initial state belongs in a Service getter, a Signal/Readable, or an ExtensionPoint's current snapshot. Events neither cache nor replay, and no listener order exists between setups in the same layer.

## Keeping control handles

A composition root that needs removal or replacement keeps the Installation returned by `install()`:

```ts
const installations = new Map<string, Installation>()
installations.set("player", host.install(playerPlugin))

await installations.get("player")?.remove()
```

Diagnostics are observation only, never a control plane. Every dependency edge must point to a real capability: provide that capability's port or domain state rather than adding a marker atom or encoding installation order in an empty Service.
