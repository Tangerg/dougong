# Migrating from 0.8.3 to 0.9.0

0.9.0 changes package boundaries, installation transitions, plugin contexts and shutdown contracts. Upgrading requires application changes; removed APIs have no aliases or compatibility adapters. The [release notes](../reference/release-0.9.0.md) describe the full release scope.

## 1. Update dependencies and imports

```sh
pnpm add dougong@0.9.0
```

Applications that directly depend on `@dougongjs/core` should remove it from their dependency manifest and import its core APIs from `dougong`. There are three packages in 0.9.0; previously published Core versions remain available.

| Import location in 0.8.3 | Import location in 0.9.0 |
| --- | --- |
| Contracts, plugins, Host and resource protocols from `@dougongjs/core` | `dougong` |
| Platform APIs re-exported by `dougong` | `@dougongjs/platform` |
| Reactive APIs re-exported by `dougong` | `@dougongjs/reactive` |
| Core's `SnapshotPublisher`, `ReadonlyMapSnapshot`, `SerialQueue`, `normalizePlainRecord` | `dougong/advanced` |

Install the matching 0.9.0 delivery or reactive package when needed and import it directly. The main package no longer re-exports either layer.

```ts
import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";
import { SnapshotPublisher } from "dougong/advanced";
import { createPlatform } from "@dougongjs/platform";
import { bridge, computed, observe, signal } from "@dougongjs/reactive";
```

Packages remain ESM and require Node.js `^24.22.0 || >=26.10.0`. Browser support starts at Chrome/Edge 119, Firefox 124 and Safari 17.4. TypeScript consumers need the `ES2024`, `DOM` and `ESNext.Disposable` libraries. Native browser modules must also retain the shipped `runtime/` directory and map its private import; see [getting started](./getting-started.md#native-browser-modules).

## 2. Replace installation commands with planning and execution

Installation and Group are now read-only identities. Replace direct Host installation, Installation updates and removal, Group removal and ChangeSet commit calls with staged intent, a Plan and its application.

```ts
import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";

const GREETER = service<{ greet(name: string): string }>("application/greeter");
const greeter = definePlugin({
  name: "application.greeter",
  provides: { greeter: GREETER },
  setup() {
    return { greeter: { greet: (name) => `Hello, ${name}` } };
  },
});

const host = createHost({ name: "application" });
const change = host.change();
const installation = change.install(greeter, { id: "greeter" });
const plan = await host.plan(change);
await host.apply(plan);
await host.start();

const message = await host.use(GREETER, (value) => value.greet("Dougong"));
console.log(message);

const removal = host.change();
removal.remove(installation);
await host.apply(await host.plan(removal));
await host[asyncDisposeSymbol]();
```

Every installation needs a stable `id` unique within its Host. Create groups with `change.group(id, parent)` and remove their ownership subtrees with `change.removeGroup(group)`. Initial declarations can also be supplied through `createHost` options `installations` and `groups`. Query committed identities with `host.installation(id)` and `host.group(id)`.

Replace waits on old handle ready methods with awaits on `plan`, `apply`, `start` or `stop`. Configuration validation runs during planning; apply uses the captured result. Planning does not execute setup. A running transition publishes the whole change after all candidates have prepared.

A Plan belongs to its issuing Host and state revision and is single-use. A persisted report cannot be replayed as authority. [`HOST_BUSY`](../reference/errors.md) leaves a Plan unconsumed; [`PLAN_STALE`](../reference/errors.md) requires creating a new ChangeSet and planning against current state. `host.plan(change, signal)` can cancel pending planning without revoking an already issued Plan.

Successful `apply`, `start` and `stop` calls return `{ stateRevision, affectedInstallations }`; failures reject. Operations with no change preserve the revision. Read diagnostics through `host.diagnostics.get()` and subscribe through that same view.

## 3. Update plugin contexts and configuration

| 0.8.3 spelling | 0.9.0 spelling |
| --- | --- |
| Dependency aliases directly on context | `context.dependencies.alias` |
| context.meta | `context.metadata`, typed as `InstanceMetadata` |
| context.log | `context.logger` |
| context.signal, context.spawn | `context.lifetime.signal`, `context.lifetime.spawn` |
| context.cleanup(cleanup) | `context.lifetime.defer(cleanup)` |
| context.lifetime(label) | `context.lifetime.child(label)` |
| context.on, context.emit | `context.events.on`, `context.events.emit` |
| context.contribute | `context.contributions.add` |
| config on Plugin, installation options, updates and Artifact | `configuration` |
| ConfigValidationError, CONFIG_INVALID | `ConfigurationValidationError`, [`CONFIGURATION_INVALID`](../reference/errors.md) |

Dependency declarations are still named `requires`; their resolved values live under `dependencies`. Configuration remains the second setup argument.

Resource operations belong to `context.lifetime`. Register standard resources with `use(resource)`, asynchronous acquisition with `acquire(factory)` and final cleanup with `defer(cleanup)`. Acquisition resolves to a frozen `{ resource }` receipt; destructure it to obtain the resource. Use `interrupt(interruptWork)` to unblock work before joining tasks and releasing resources.

The root `LifetimeContext` grants resource and work registration; Engine alone stops the Instance. Create a `ChildLifetime` when early disposal is needed and close it through the standard asynchronous disposal protocol. Events and contributions belong to the root by default; pass `{ lifetime: child }` to assign a child owner.

Configuration inputs and schema outputs must contain finite numbers, strings, booleans, null, dense arrays or plain data records. Move connections, functions, Promises, class instances and getters out of configuration into declared services or Lifetime acquisition. Dougong captures and freezes configuration; rollback reuses validated committed values without rerunning the old validator.

If you used an early 0.9 development snapshot, also replace deps with dependencies, shutdownTimeoutMs with `shutdownTimeoutMilliseconds`, captureConfig with `captureConfiguration`, ConfigValue with `ConfigurationValue` and PluginConfigDescriptor with `PluginConfigurationDescriptor`. Replace the former Host inspect method with `host.diagnostics.get()` and remove checks of an outcome field on successful results.

## 4. Borrow services and executable contributions

Replace the former Host get method with `host.use(token, callback)` and finish the operation inside the callback. When it returns a Promise, the borrow lasts until settlement. Do not save the service globally or return it to a longer-lived consumer.

Contribution snapshots change from Maps of values to frozen, ordered arrays of IDs. Borrow for both display data and handler execution:

```ts
const commands = host.contributions(COMMANDS);
for (const id of commands.get()) {
  const title = await commands.use(id, (command) => command.title);
  console.log(title);
}
```

Removal, update and shutdown check affected generations for active borrows. Asynchronous event listener invocations also borrow their owners, and emit joins all listener results. Use `lifetime.spawn` for work that continues independently of a broadcast. Candidate setup must not emit public events.

Subscriptions, contributions and resource handles use `Symbol.dispose` or `Symbol.asyncDispose`; replace old named dispose calls. Custom Readable subscriptions must unsubscribe synchronously. Use `bridge(owner, source)` to connect a reactive source from another bundle or module copy to the local computed graph.

## 5. Rebuild Platform delivery flows

Construct Platform with a stable `id` and its full `host`. The old installer option is replaced by `host` and an optional committed `group`. Add an Artifact with an explicit `revision` to the Catalog, then select and activate it.

```ts
import { createPlatform, MemoryLoader } from "@dougongjs/platform";

const deliveryHost = createHost();
await deliveryHost.start();
const platform = createPlatform({
  id: "application-plugins",
  host: deliveryHost,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["greeter-module", { default: greeter }]])),
});
const artifact = platform.catalog.add({
  revision: "greeter-content-1",
  manifest: { name: greeter.name, version: "1.0.0" },
  reference: "greeter-module",
});
const registration = await platform.select(artifact);
await platform.activate([registration]);
await deliveryHost.use(GREETER, (value) => value.greet("Dougong"));
await platform[asyncDisposeSymbol]();
await deliveryHost[asyncDisposeSymbol]();
```

This example reuses the core imports, plugin and service contract above. Select a new Artifact to express an update. Use `platform.activate(registrations, { remove })` for one atomic install/update/removal batch and `platform.remove(...registrations)` for a separate removal. Replace old Registration ready, activate, update and remove calls and the old Platform ChangeSet. Registration is now a read-only selection identity.

Remove executable placeholders. Before lazy activation, use Manifest data for discovery; borrow real capabilities after activation. `selectedArtifact` describes intent and `activeOrigin` describes the revision actually committed by Core. They can differ temporarily.

Custom Loaders implement `load(reference, signal)`. Authorizers receive `{ artifact, operation }` and a cancellation signal; operation distinguishes load from activate. Activation admission also covers this Platform's committed Artifacts that the Plan restarts. A directly caught `PermissionDeniedError` retains its typed properties; recorded permission data moves to manifestName and denied under `error.snapshot.fields`.

## Handle failure and finish the migration

Failed or timed-out shutdown retains real resource obligations and quarantines the entire Host. `quarantined` is terminal: replaying start, stop or apply, or constructing a replacement Host, does not prove that old resources were released. Late completion only updates diagnostics. Follow the [quarantine procedure](./transactions.md#quarantine) to stop dispatch, retain diagnostics and handle the old execution boundary.

After upgrading, exercise installation, updates, removal, busy rejection during borrowing, failed-transition restoration and shutdown. Rollback creates new Instances from previous declarations; it does not resurrect old objects or reverse external file and network effects. See the [Core API](../reference/core-api.md) and [Platform specification](../reference/platform.md) for the complete protocols.
