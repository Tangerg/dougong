# External plugin delivery

Every Plugin so far has been **written by application code**: you `import` it, then `install` it.

`@dougongjs/platform` handles the other case — plugins that come from **outside**: a third-party registry, a user-installed extension, a dynamically downloaded module. That raises four concerns Core should not know about:

1. What does this module **declare** (manifest)
2. From where and when is it **loaded** (loader)
3. What is it allowed to do (permissions)
4. When is it **activated** (activation)

Platform compiles those four into Core operations. It **does not duplicate** Core's registries, dependency graph, transactions, resource ownership, observation protocol or error semantics.

## The mental model

```text
Application code → Platform → Artifact / Registration
                              ↓ compiles changes to
                     Installer (Host or Group) → Installation
```

Platform consumes the `change()` capability of an `Installer` (normally a Host or Group) and compiles external Plugins into the canonical Core ChangeSet. Its internal port is narrowed on the consuming side to `Pick<Installer, "change">`, while a complete `Installer` still precisely means `install/group/change`.

## A minimal example

```ts
import { createHost } from "dougong"
import { createPlatform, ImportLoader, defineManifest } from "dougong"

const host = createHost({ name: "editor" })
await host.start()

const platform = createPlatform({
  installer: host,                      // the compilation target
  apiVersion: "1.0.0",                  // the application API version
  loader: new ImportLoader(),     // how modules are loaded
})

const registration = await platform.register({
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
interface Manifest {
  readonly name: string
  readonly version: string
  readonly apiVersion: string                        // required application API range
  readonly activation: ReadonlyArray<string>         // activation events
  readonly permissions: ReadonlyArray<string>
  readonly dependencies: Readonly<Record<string, string>>
}
```

`defineManifest()` fills optional fields, validates the shape and freezes the result. An invalid manifest throws `MANIFEST_INVALID` — **before any module code is loaded**.

A mismatched `apiVersion` throws `API_INCOMPATIBLE`. That is the compatibility contract between the application API and an external Plugin.

## The loader is the execution boundary

```ts
interface Loader<Reference> {
  load(reference: Reference, signal: AbortSignal): Promise<unknown>
}
```

`Reference` is generic — a URL, file path, module ID, blob, anything your application can resolve. Platform does not care.

Two implementations ship with it:

```ts
new ImportLoader()        // dynamic import(); Reference is string | URL
new MemoryLoader(map)     // from a Map, for tests
```

The Loader is the **only** place external code executes. A failed load throws `MODULE_LOAD_FAILED`; a module that does not export a valid `Plugin` throws `MODULE_INVALID`.

The `signal` makes loading cancellable, so removing a plugin mid-load does not leave an orphan import running.

## Permissions are a policy port, not a sandbox

```ts
import { PermissionSet } from "dougong"

const platform = createPlatform({
  installer: host,
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  authorizer: new PermissionSet(["fs:read", "net:fetch"]),
})
```

Or supply your own authorizer — for example one that asks the user:

```ts
const authorizer = {
  async authorize(manifest, signal) {
    const granted = await askUser(manifest.name, manifest.permissions)
    if (!granted) throw new PermissionDeniedError(manifest.name, manifest.permissions)
  },
}
```

::: danger This is not a sandbox
The permission check happens **before** the module executes. It decides whether to run the code, not what the code may touch.

Authorization runs at Artifact admission and activation boundaries; it does not intercept every later `contribute()`. If an ExtensionPoint needs per-contribution capability checks, put permission labels in the domain value and enforce them in that point's domain composer or a restricted Service. Platform does not duplicate Core's contribution registry.

Once a JavaScript module is imported it shares the application's realm and reaches the same globals. Real isolation needs a Worker, iframe, process or separate Host — Platform does not pretend otherwise.

Authorization is re-checked **immediately before** module execution, so revoking a permission takes effect at once for plugins that have not yet activated.
:::

## Register, placeholder, lazy activation

External plugins usually should not all load at startup. Platform's model is **registration ≠ activation**:

```ts
const registration = await platform.register({
  manifest,
  reference: "./heavy-plugin.js",
  placeholder: lightweightStub,     // optional: an application-authored Plugin
})

registration.status      // "registered" → not loaded yet
await registration.activate()       // activate explicitly
registration.status      // "activated"
```

The `placeholder` is an **application-authored Plugin** standing in until the loaded Plugin activates. That is what makes "the command is already in the menu, but the implementation loads on click" possible — and the swap is **atomic**, through the same Core ChangeSet.

Activation can also be event-driven:

```ts
// manifest.activation: ["onLanguage:markdown", "onCommand:acme.format"]
await platform.trigger("onLanguage:markdown")
```

`trigger()` activates every Registration declaring that event **concurrently**. One failure is rethrown as-is; multiple independent failures become an `AggregateError`, and one Registration's failure never cancels the others.

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
| `REGISTRATION_DEPENDENCY_MISSING` | the dependency has no Registration |
| `REGISTRATION_DEPENDENCY_INCOMPATIBLE` | the dependency Registration is outside the version range |
| `REGISTRATION_DEPENDENCY_INACTIVE` | the dependency Registration is not activated |
| `REGISTRATION_CYCLE` | manifest dependencies form a cycle in the candidate Registration graph |
| `REGISTRATION_DUPLICATE` | a Registration with that manifest name already exists |

::: tip Two graphs, separate jobs
Manifest dependencies (a **delivery** relationship between external Plugins) and Core's Service dependencies (an **execution** relationship between capabilities) are two independent graphs.

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

When execution begins, the change first fixes which updates remain activated. It then validates the candidate graph → authorizes every Manifest and preloads required modules → closes new activation admission → cancels explicit targets and awaits activation trees admitted earlier → revalidates stable state against the same plan → **compiles one Core ChangeSet** → commits.

Failed preflight cancels no in-flight activation. If any later step fails, Core and Platform never expose a half-committed state.

Updates check identity: the new Artifact's Manifest name must match the Registration's, otherwise `REGISTRATION_IDENTITY`. That keeps "update" from quietly becoming "register a different Plugin".

## Hot reload

`update()` keeps the Registration and Core Installation identities while replacing the active Instance:

```ts
await registration.update({
  manifest: nextManifest,
  reference: "./plugin@1.3.0.js",
})
```

Underneath it is Core's `installation.update({ plugin })`, so only the affected dependency closure restarts. Application code wanting real HMR (watch files, compute invalidation, reload in batches) composes on top — [example 12](../examples.md#stage-3) demonstrates a complete module-graph HMR in roughly 200 lines.

## Diagnostics

```ts
platform.diagnostics.get()
// { apiVersion, status, registrations: ReadonlyMap<string, RegistrationSnapshot> }

platform.diagnostics.subscribe(() => render())
```

The same `get` / `subscribe` protocol Core uses — Platform's diagnostics compile onto Core's `SnapshotPublisher` rather than reimplementing it, and an architecture guard enforces that.

## Disposal

```ts
await platform.dispose()
// or
await using platform = createPlatform({ ... })
```

Disposal cancels in-flight activations, removes every Core Installation and closes diagnostics. Any Platform method afterwards throws `PLATFORM_UNAVAILABLE`.

## Next

- [Platform specification](../reference/platform.md) — exact semantics and edge cases
- [Error codes](../reference/errors.md) — stable codes and their trigger conditions
- [Runnable examples 08 / 12](../examples.md) — lazy activation and module-graph HMR end to end
