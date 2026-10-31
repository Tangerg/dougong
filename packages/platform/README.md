# @dougongjs/platform

External artifact selection, admission and lazy activation compiled into Dougong plans.

Platform owns available artifacts and the user's selected targets. Dougong owns committed
installations, their source information, running generations and resources. Platform uses
only the public `dougong` and `dougong/advanced` protocols.

## A complete lifecycle

```ts
import { createHost, definePlugin, service } from "dougong";
import { createPlatform, MemoryLoader } from "@dougongjs/platform";

const COUNTER = service<{ value: number }>("example/counter");
const counter = definePlugin({
  name: "example.counter",
  provides: { counter: COUNTER },
  setup() {
    return { counter: { value: 1 } };
  },
});

await using host = createHost();
await host.start();

await using platform = createPlatform({
  id: "extensions",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["counter-v1", { default: counter }]])),
});

const artifact = platform.catalog.add({
  revision: "counter-build-1",
  manifest: { name: counter.name, version: "1.0.0" },
  reference: "counter-v1",
});
const registration = await platform.select(artifact);

const preview = platform.preview([registration]);
if (preview.blockers.length === 0) {
  await platform.activate([registration]);
}

console.log(await host.use(COUNTER, counter => counter.value));
```

`select` records a target without loading or running code. `activate` loads the complete
selected dependency closure and submits one Core plan. `trigger("startup")` activates all
matching roots in the same way. Module loading and configuration validation remain explicit
deferred checks in the metadata-only preview.

The scope disposes Platform before Host. For an explicit release, await
`platform[Symbol.asyncDispose]()`. There is no parallel `dispose()` API.

## Availability, selection and committed source

| Fact | Owner | Public projection |
| --- | --- | --- |
| Available artifact revisions | Catalog | `catalog.get(name, revision)` and `catalog.list()` |
| Selected target | Registration | `selectedArtifact`, `selectionRevision` |
| Committed implementation source | Core Installation | `activeOrigin` |
| Execution generation | Core Engine | `installation.status` and Host inspection |
| Last activation failure | Registration | `error`, captured without resource references |

An artifact revision cannot be reused within its Catalog, even after removal. Removing an
available artifact does not remove selected or committed source data. A URL or loader
reference is a location, not a verified content digest. The selected Loader owns reference
resolution and any integrity guarantees it advertises.

Config uses Dougong's captured data protocol. Mutating the caller's input after `catalog.add`
cannot change a later activation. Functions and resource instances belong in Service
contracts, not config.

To update, add a new revision, select it, then activate the stable Registration. If setup
fails and Core restores the previous graph, `selectedArtifact` remains the new target while
`activeOrigin` remains the old committed source. The failed target is not silently discarded.
A stopped Host can contain committed installations; `activeOrigin` does not imply that their
Instances are currently running.

Registration keeps the Installation handle it created. It projects that handle only while
Core still recognizes the same committed identity. A matching ID or copied origin data cannot
make it adopt another installation. Platforms that collide on an installation ID receive
Core's normal conflict error; removing either Registration cannot remove the other's identity.

## Atomic deployment changes

```ts
const preview = platform.preview([nextProvider, nextConsumer], {
  remove: [obsoleteProvider],
});

await platform.activate([nextProvider, nextConsumer], {
  remove: [obsoleteProvider],
  signal: controller.signal,
});
```

The final artifact dependency graph is validated before loading. Core receives removals,
updates and additions in one ChangeSet, so a provider can be replaced by a different
installation without an intermediate duplicate or missing binding. `platform.remove(...items)`
uses the same compilation path with no activation roots.

Concurrent activations share module loading but do not share a caller's cancellation.
Cancelling one waiter cannot cancel a load another waiter still needs. Every operation
captures each involved Registration's selection revision. A late result from an older
selection cannot install itself. Selection commands and the final activation commit are
serialized; long module loading runs outside that boundary.

Cancellation before the Core handoff prevents that handoff. Once Core execution has started,
Platform awaits and reports its actual outcome rather than calling a committed operation
cancelled. Dynamic import side effects are outside Core rollback.

## Admission

```ts
const authorizer = {
  authorize({ artifact, operation }, signal) {
    signal.throwIfAborted();
    policy.check({
      name: artifact.manifest.name,
      revision: artifact.revision,
      permissions: artifact.manifest.permissions,
      operation,
    });
  },
};
```

Admission receives the concrete artifact descriptor and either `load` or `activate`.
`PermissionSet` implements a fixed allow-list of manifest permission names; the default
policy grants none. Loading checks happen after dependency waits and immediately before the
Loader is entered. New generations are checked again after Core planning and before apply.
Cached code is not imported again merely to perform another policy check.

Admission authorizes an attempt. It does not sandbox admitted code or revoke already-started
same-realm JavaScript. `ImportLoader` preserves native import caching and does not claim
transitive HMR or cancellation of module evaluation. Use a Loader backed by a real execution
boundary when stronger execution controls are required.

## Placement and diagnostics

`PlatformOptions.group` can place installations in a committed Group owned by `host`.
Group remains an installation-ownership boundary. A removed Group is rejected before loading;
removing the now-unavailable Registrations or disposing Platform remains possible.

`platform.diagnostics` follows the Core snapshot protocol. Its reads synchronize against the
current Host snapshot, so an earlier Host observer also sees the current committed source.
Observer failures go to the logger without changing an already committed result. Terminal
Registration handles and diagnostic views detach from live Host and Loader capabilities.

A failed Core cleanup keeps the Platform's installation ownership and exposes the quarantined
execution state. Core quarantine is terminal for the whole Host. Retrying activation or
recreating Platform cannot restore it, and creating a new Host does not release old resources.
Follow the [Core quarantine procedure](https://tangerg.github.io/dougong/en/guide/transactions#quarantine)
to handle the old execution boundary before a replacement takes over.
