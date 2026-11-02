# @dougongjs/platform

External artifact selection, admission and lazy activation compiled into Dougong plans.

Upgrading from 0.8.3? Read the [migration guide](https://tangerg.github.io/dougong/en/guide/migrating-to-0.9) and [0.9.0 release notes](https://tangerg.github.io/dougong/en/reference/release-0.9.0).

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

The scope disposes Platform before Host. For explicit disposal across the supported runtimes,
import `asyncDisposeSymbol` from `dougong` and await `platform[asyncDisposeSymbol]()`.

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

Use `platform.registrations()` to enumerate the current Registration handles for commands.
The frozen array captures membership at the time of the call; removed handles never acquire
authority over later selections. Diagnostic snapshots carry data, not command handles.
Platform snapshots retain identity and do not notify observers for unrelated Core activity.

Module caching follows Artifact reachability. A withdrawn Artifact which is no longer selected
or otherwise retained does not pin its loaded plugin for the lifetime of the Platform.

Configuration uses Dougong's captured data protocol. Mutating the caller's input after `catalog.add`
cannot change a later activation. Functions and resource instances belong in Service
contracts, not configuration.

To update, add a new revision, select it, then activate the stable Registration. If setup
fails and Core restores the previous graph, `selectedArtifact` remains the new target while
`activeOrigin` remains the old committed source. The failed target is not silently discarded.
A blocked dependency closure records its failure on the affected selections. Preview only reports the blockers.
A stopped Host can contain committed installations; `activeOrigin` does not imply that their
Instances are currently running.

Registration keeps the Installation handle it created. It projects that handle only while
Core still recognizes the same committed identity. On that Installation, reuse requires
both the declared revision and the normalized Manifest to agree with the selection. An
externally changed Manifest with the same revision still needs an update. A matching ID or copied origin data cannot
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
selection cannot install itself. Concurrent loads and activations admitted before a final handoff keep their place. While final
configuration validation, authorization, Core application, or disposal cleanup is executing,
a newly requested select, activate, remove or trigger rejects with `PLATFORM_BUSY`.
Disposal cancels unfinished validation and authorization. During Core application or release it rejects with `PLATFORM_BUSY`.
This avoids waiting for the user callback that made the request. Wait until the outer
operation finishes before issuing another command. Cancellation callbacks can read the complete
new selection, removal batch or disposal phase through handles and diagnostics. Preview and reads remain available
while the Platform is active. A loader must not recursively wait for its own module result.

Cancellation before the Core handoff ends the caller's wait, even for a validator or
authorizer that never settles. A late preparation cannot submit its Plan or overwrite
the selected Registration's last failure. Once Core execution has started,
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
An Authorizer approves by returning or resolving with `undefined`. To deny, throw or reject.
If an existing JavaScript policy returns a boolean, change its false branch to throw and
let its true branch return normally. Any non-undefined result is a policy protocol error.
`PermissionSet` implements a fixed allow-list of manifest permission names; the default
policy grants none. Loading checks happen after dependency waits and immediately before the
Loader is entered. Before submitting its plan, Platform authorizes each requested install or
update and each of its own committed artifacts that Core will restart because a binding changed.
An indirect restart uses the committed origin, even if a newer revision is selected. If a direct Host update
removed or invalidated that origin, or declared an incompatible API range, admission rejects the whole
change. Include the affected Registration in the activation to restore its selected Artifact.
These checks cover the forward deployment. Once Core starts applying the plan, failed setup can
reconstruct the previously committed revisions during rollback, using their prior admission.
Direct Host commands and commands from other Platforms also operate outside this admission hook.

Admission authorizes an attempt. It does not sandbox admitted code or revoke already-started
same-realm JavaScript. `ImportLoader` preserves native import caching and does not claim
transitive hot module replacement or cancellation of module evaluation. Use a Loader backed by a real execution
boundary when stronger execution controls are required.

## Placement and diagnostics

`PlatformOptions.group` can place installations in a committed Group owned by `host`.
Group remains an installation-ownership boundary. Platform checks the Host and Group before
and after load admission. A quarantined Host or a removed Group cannot start module evaluation;
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
