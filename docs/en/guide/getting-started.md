# Getting started

This page takes about ten minutes: install Dougong, write your first capability composition, and understand what separates it from an ordinary DI container.

## Requirements

| Item | Requirement |
| --- | --- |
| Node.js | ≥ 22 |
| JavaScript runtime | Must provide ES2024 standard capabilities, including `Promise.withResolvers()` |
| TypeScript | ≥ 5.5 (if you use TypeScript) |

::: warning Browser and WebView runtimes
`Promise.withResolvers()` requires Safari 17.4+ (macOS 14.4+), Chrome 119+ or Firefox 121+.
If you embed a system WebView through Electron, Tauri or Wails, check your minimum target OS first.

Explicit `.dispose()` does not require Explicit Resource Management support from the runtime. `using` / `await using` additionally require `Symbol.dispose` / `Symbol.asyncDispose`; when they are not native, the application must install a polyfill before importing Dougong. Dougong does not mutate globals.
:::

## Install

```sh
npm install dougong
```

`dougong` is the facade package; it re-exports the three real packages. Install them individually if you only need part of the system:

```sh
npm install @dougongjs/core       # the six atoms, dependency graph, transactions, diagnostics
npm install @dougongjs/reactive   # signal value layer and observe (zero dependencies)
npm install @dougongjs/platform   # manifests, permissions, lazy activation, HMR
```

### TypeScript configuration

Dougong's types use `Symbol.dispose` and `AbortSignal`, so your `tsconfig.json` must include the matching libs:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"],
    "moduleResolution": "Bundler",
    "strict": true
  }
}
```

::: danger What happens without them
Writing only `"lib": ["ES2024"]` produces a wall of errors pointing into `node_modules`, which looks like a broken library:

```
Property 'dispose' does not exist on type 'SymbolConstructor'
Cannot find name 'AbortSignal'
```

Adding `DOM` and `ESNext.Disposable` fixes it.
:::

## Your first composition

A complete, runnable example. The provider publishes a stable Service; the consumer declares its dependency through `requires`.

```ts
import { createHost, definePlugin, service } from "dougong"

interface Clock {
  now(): Date
}

interface Greeter {
  greet(name: string): string
}

// 1. A Contract is a frozen identity token binding a type to a string ID
const CLOCK = service<Clock>("example/clock")
const GREETER = service<Greeter>("example/greeter")

// 2. Provider: declare in provides, return the implementation from setup
const clock = definePlugin({
  name: "example.clock",
  provides: { clock: CLOCK },
  setup: () => ({ clock: { now: () => new Date() } }),
})

// 3. Consumer: declare in requires, read from ctx
const greeter = definePlugin({
  name: "example.greeter",
  requires: { clock: CLOCK },
  provides: { greeter: GREETER },
  setup: (ctx) => ({
    greeter: {
      greet: (name) => `${ctx.clock.now().toISOString()} Hello, ${name}`,
    },
  }),
})

const host = createHost({ name: "hello" })
host.install(greeter)   // note: the consumer goes first
host.install(clock)     // the provider second — order does not matter

await host.start()
console.log(host.get(GREETER).greet("Dougong"))
await host.stop()
```

Output:

```text
2026-08-15T00:00:00.000Z Hello, Dougong
```

## What just happened

### Install order is not start order

`greeter` is installed first but depends on `clock`. During `host.start()`, Dougong builds a dependency graph from the `requires` / `provides` declarations, topologically sorts it, **starts each topological layer concurrently**, and stops in reverse dependency order.

You never sort by hand, and there is no `dependsOn: ["example.clock"]` string array — the dependency is already in the types.

### A plugin can only read what it declared

```ts
definePlugin({
  name: "bad",
  setup(ctx) {
    ctx.clock.now()   // ❌ compile error
  },                  //    Property 'clock' does not exist on type 'PluginContext<{}>'
})
```

The type of `ctx` is derived from `requires`. Undeclared means the property does not exist — a **compile-time** error, not an `undefined` discovered during execution.

This is the most practical difference from most plugin frameworks. Where dependencies resolve through strings or an ambient context, a forgotten declaration usually shows up as "works sometimes, undefined other times", depending on load order.

### `host.get()` is for application code, not for Plugins

```ts
host.get(GREETER)     // ✓ application code crossing the Host boundary
ctx.get(GREETER)     // ✗ no such method
```

Plugins relate to each other through `requires` so that the dependency graph is complete. If a plugin could pull any capability from a service locator at will, the graph would stop reflecting real dependencies, and both topological ordering and transactional rollback would lose their meaning.

`host.get()` only works while `status === "active"`; otherwise it throws `SERVICE_UNAVAILABLE`.

## Run the repository examples

To see fuller scenarios directly:

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong
pnpm install
pnpm examples        # run the nine examples in order
pnpm check           # the full verification gate
pnpm docs:dev        # serve this documentation site locally
```

Twelve chapters climb three stages — atoms, composition, complete applications — from a minimal Service through the Planet / Lynx scenarios to declarative plans and module-graph HMR, all in CI. See [runnable examples](../examples.md).

## Next

- **Understand the model** → [Core concepts](./concepts.md): what each atom solves, and why an ExtensionPoint is not a Service
- **Start writing code** → [Writing plugins](./writing-plugins.md): config validation, optional dependencies, failure handling
- **Worried about leaks** → [Lifetime and resources](./lifetime.md)
- **Need exact semantics** → [Core API specification](../reference/core-api.md)
