# External plugin delivery

Every plugin so far has been **written by the host**: you `import` it, then `install` it.

`@dougongjs/platform` handles the other case — plugins that come from **outside**: a third-party registry, a user-installed extension, a dynamically downloaded module. That raises four concerns Core should not know about:

1. What does this module **declare** (manifest)
2. From where and when is it **loaded** (loader)
3. What is it allowed to do (permissions)
4. When is it **activated** (activation)

Platform compiles those four into Core operations. It **does not duplicate** Core's registries, dependency graph, transactions, resource ownership, observation protocol or error semantics.

## The mental model

```text
Host
 └─ PluginPlatform            ← external concerns: manifest / loader / permissions / activation
      └─ PluginContainer      ← this is Core's Application
           └─ installed plugins
```

Platform takes a `PluginContainer` (an Application or a Group) and compiles external plugins into `install` / `update` / `remove` against it.

## A minimal example

```ts
import { createApp } from "dougong"
import { createPlatform, ImportPluginLoader, defineManifest } from "dougong"

const app = createApp({ name: "editor" })
await app.start()

const platform = createPlatform({
  container: app,                       // the compilation target
  apiVersion: "1.0.0",                  // the host API version
  loader: new ImportPluginLoader(),     // how modules are loaded
})

const plugin = await platform.register({
  manifest: defineManifest({
    name: "acme.markdown",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["onLanguage:markdown"],
    permissions: ["fs:read"],
  }),
  reference: "https://cdn.example.com/acme-markdown.js",
})

await platform.trigger("onLanguage:markdown")   // activate
```

## Manifest

A manifest is an external plugin's **declaration**, validated and frozen at the trust boundary:

```ts
interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly apiVersion: string                        // what it requires of the host
  readonly activation: ReadonlyArray<string>         // activation events
  readonly permissions: ReadonlyArray<string>
  readonly dependencies: Readonly<Record<string, string>>
}
```

`defineManifest()` fills optional fields, validates the shape and freezes the result. An invalid manifest throws `MANIFEST_INVALID` — **before any module code is loaded**.

A mismatched `apiVersion` throws `API_INCOMPATIBLE`. That is the only compatibility contract between host and external plugin.

## The loader is the execution boundary

```ts
interface PluginLoader<Reference> {
  load(reference: Reference, signal: AbortSignal): Promise<unknown>
}
```

`Reference` is generic — a URL, file path, module ID, blob, anything your host can resolve. Platform does not care.

Two implementations ship with it:

```ts
new ImportPluginLoader()        // dynamic import(); Reference is string | URL
new MemoryPluginLoader(map)     // from a Map, for tests
```

The loader is the **only** place external code executes. A failed load throws `MODULE_LOAD_FAILED`; a module that does not export a valid plugin definition throws `MODULE_INVALID`.

The `signal` makes loading cancellable, so removing a plugin mid-load does not leave an orphan import running.

## Permissions are a policy port, not a sandbox

```ts
import { PermissionSet } from "dougong"

const platform = createPlatform({
  container: app,
  apiVersion: "1.0.0",
  loader: new ImportPluginLoader(),
  permissions: new PermissionSet(["fs:read", "net:fetch"]),
})
```

Or supply your own authorizer — for example one that asks the user:

```ts
const permissions = {
  async authorize(manifest, signal) {
    const granted = await askUser(manifest.name, manifest.permissions)
    if (!granted) throw new PermissionDeniedError(manifest.name, manifest.permissions)
  },
}
```

::: danger This is not a sandbox
The permission check happens **before** the module executes. It decides whether to run the code, not what the code may touch.

Once a JavaScript module is imported it shares the host's realm and reaches the same globals. Real isolation needs a Worker, iframe, process or separate Application — Platform does not pretend otherwise.

Authorization is re-checked **immediately before** module execution, so revoking a permission takes effect at once for plugins that have not yet activated.
:::

## Register, placeholder, lazy activation

External plugins usually should not all load at startup. Platform's model is **registration ≠ activation**:

```ts
const plugin = await platform.register({
  manifest,
  reference: "./heavy-plugin.js",
  placeholder: lightweightStub,     // optional: a host definition exposed before activation
})

plugin.status      // "registered" → not loaded yet
await plugin.activate()             // activate explicitly
plugin.status      // "active"
```

The `placeholder` is a **host-authored** plugin definition standing in until the real module activates. That is what makes "the command is already in the menu, but the implementation loads on click" possible — and the swap from placeholder to real implementation is **atomic**, through the same Core ChangeSet.

Activation can also be event-driven:

```ts
// manifest.activation: ["onLanguage:markdown", "onCommand:acme.format"]
await platform.trigger("onLanguage:markdown")
```

`trigger()` activates every plugin declaring that event, **concurrently**, aggregating independent failures into an `AggregateError` — one failed activation does not affect the others.

## Manifest dependencies

External plugins may depend on each other:

```ts
defineManifest({
  name: "acme.theme-dark",
  dependencies: { "acme.theme-base": "^2.0.0" },
})
```

Platform activates them in dependency order and checks:

| Code | Condition |
| --- | --- |
| `PLUGIN_DEPENDENCY_MISSING` | the dependency is not registered |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | registered but outside the version range |
| `PLUGIN_DEPENDENCY_INACTIVE` | present but failed to activate |
| `PLUGIN_CYCLE` | manifest dependencies form a cycle |
| `PLUGIN_DUPLICATE` | a plugin with that name is already registered |

::: tip Two graphs, separate jobs
Manifest dependencies (a **delivery** relationship between external plugins) and Core's Service dependencies (a **runtime** relationship between capabilities) are two independent graphs.

Manifest dependencies decide load order; Service dependencies decide start order. Platform does not fold one into the other.
:::

## Platform ChangeSet

As in Core, changes to several external plugins go through one transaction:

```ts
const changes = platform.change()
changes.register(newPlugin)
changes.update(existing, nextArtifact)
changes.remove(deprecated)
await changes.commit()
```

It then, in order: awaits in-flight operations on the affected plugins → authorizes every manifest → validates the candidate dependency graph → loads modules → **compiles one Core ChangeSet** → commits.

If any step fails, Core has not moved at all.

Updates check identity: the new artifact's manifest name must match the existing plugin's, otherwise `PLUGIN_IDENTITY`. That keeps "update" from quietly becoming "replace with a different plugin".

## Hot reload

`update()` keeps the instance identity and swaps the implementation:

```ts
await plugin.update({
  manifest: nextManifest,
  reference: "./plugin@1.3.0.js",
})
```

Underneath it is Core's `handle.update({ plugin })`, so only the affected dependency closure restarts. A host wanting real HMR (watch files, compute invalidation, reload in batches) composes on top — [example 12](../examples.md#stage-3) demonstrates a complete module-graph HMR in roughly 200 lines.

## Diagnostics

```ts
platform.diagnostics.get()
// { apiVersion, status, plugins: ReadonlyMap<string, ManagedPluginSnapshot> }

platform.diagnostics.subscribe(() => render())
```

The same `get` / `subscribe` protocol Core uses — Platform's diagnostics compile onto Core's `SnapshotPublisher` rather than reimplementing it, and an architecture guard enforces that.

## Disposal

```ts
await platform.dispose()
// or
await using platform = createPlatform({ ... })
```

Disposal cancels in-flight activations, removes every installed handle from Core and closes diagnostics. Any Platform method afterwards throws `PLATFORM_UNAVAILABLE`.

## Next

- [Platform specification](../reference/platform.md) — exact semantics and edge cases
- [Error codes](../reference/errors.md) — all 25 stable codes
- [Runnable examples 08 / 12](../examples.md) — lazy activation and module-graph HMR end to end
