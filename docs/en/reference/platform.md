# Dougong Platform specification

`@dougongjs/platform` compiles an external Plugin's Manifest, loading, version constraints, activation policy and permission decisions into ordinary `@dougongjs/core` Plugins and ChangeSets. It is not a second execution engine: the Service graph, Lifetimes, Group ownership, rollback and the final truth about Instances remain in Core alone.

This document describes Platform's observable contract. For Core primitives see the [Core API specification](./core-api.md); for the layering rationale see [Architecture](./architecture.md); for a user-facing introduction see [External plugin delivery](../guide/platform.md).

## 1. Mental model

Platform adds exactly four lifecycle nouns; Loader and Authorizer remain narrow policy ports:

```text
Manifest       static identity, compatibility range, activation conditions, permission requests
Artifact       Manifest + module Reference + config + optional placeholder Plugin
Registration  the stable identity of one Artifact admitted to a Platform
Platform       owner of the registry, load policy, permission policy and atomic change
```

Typical use:

```ts
const platform = createPlatform({
  installer: host,
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  authorizer: new PermissionSet(["network"]),
});

const registration = await platform.register({
  manifest: {
    name: "music.remote",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["command:music.search"],
    permissions: ["network"],
  },
  reference: new URL("./remote-plugin.js", import.meta.url),
});

await platform.trigger("command:music.search");
await registration.ready();
```

Platform options are a plain record containing only `installer`, `apiVersion`, `loader`, `authorizer` and `logger`. Only enumerable own properties are read, and neither unknown fields nor prototype-chain configuration is accepted. `installer` consumes `Pick<Installer, "change">`; Loader, Authorizer and Logger are structural ports as well. Any of these collaborators may be implemented by an ordinary object or class instance.

`Reference` is produced by an Artifact and consumed by a Loader, so `Platform<Reference>`, `PlatformChangeSet<Reference>` and `Registration<Reference>` cannot silently widen. To support `string | URL`, declare that complete union when creating the Platform instead of creating a narrow Platform and later widening its input domain by assignment.

`register()` only admits the Artifact into the Platform; `activate()` selects and loads its external Plugin; `ready()` waits for the corresponding Core Installation to cross the Host / ChangeSet ready barrier. These three are not synonyms.

## 2. Manifest

```ts
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly activation: readonly string[];
  readonly permissions: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}
```

`defineManifest(input)` is the single normalization boundary. Defaults:

```ts
{
  apiVersion: "*",
  activation: ["startup"],
  permissions: [],
  dependencies: {},
}
```

Rules:

- `name`, activation conditions, permission names, dependency names and version ranges must be non-empty with no leading or trailing whitespace. Nothing is silently trimmed.
- `version` must be a complete semantic version. `apiVersion` and every dependency value must be a supported range; `*` explicitly means any version.
- A Manifest is a plain record made only of enumerable string own properties. Unknown fields, symbols, hidden properties, arrays and class instances are rejected rather than silently dropped or read through the prototype chain; `dependencies` follows the same record rule.
- No activation condition or permission may repeat.
- The returned object, arrays and dependency map are frozen. A Manifest is a value; it holds no execution state.
- `Manifest.name` is the Registration identity and must match the `Plugin.name` of both the placeholder and the loaded module exactly.

`apiVersion` constrains the Dougong/domain API the application exposes to Plugins; it is not the Plugin's own version. `dependencies` constrains other Manifests' versions. Service capability dependencies must still be written into Core `requires` — Manifest dependencies are not a bypass around the Service graph.

## 3. The loader is the execution boundary

```ts
interface Loader<Reference> {
  readonly load: (reference: Reference, signal: AbortSignal) => unknown | Promise<unknown>;
}
```

A loaded module must expose exactly one `Plugin` as its own `default` export; inherited properties are not module exports. Platform re-runs `definePlugin()`'s structural validation after loading and verifies the name. Loader failures are wrapped as `PlatformError` with `MODULE_LOAD_FAILED`; a bad module shape or default export uses `MODULE_INVALID`.

Built-in implementations:

- `ImportLoader` — dynamic `import()`, for trusted same-realm ESM. Explicitly **not a sandbox**.
- `MemoryLoader` — copies and reads an application-supplied read-only Map, for embedded bundles, deterministic tests and application built-in plugins; it rejects `null`, arrays and other inputs its type does not admit.

A loader must check its `AbortSignal` during expensive phases. Platform reuses Core's `isCancellationReason()` classifier and checks the signal again after the loader returns, so an uncooperative loader cannot commit a module into Core after cancellation — but the I/O and module top-level side effects it already performed cannot be undone.

`load` is a strict function property rather than a bivariant method signature: a Loader accepting only a subset of `Reference` cannot masquerade as one that accepts the whole set. Class methods still implement the structural protocol directly; the built-in `MemoryLoader` itself uses the same function-property form, so its generic instances cannot bypass the Loader constraint either.

Untrusted Plugins belong in a Worker, iframe, separate process or restricted realm. The corresponding Loader can return an **application-authored RPC proxy `Plugin`** that maps granted capabilities onto ordinary Services. What you cannot do is `import()` arbitrary code into the application's realm first and then expect Context permissions to make it safe.

## 4. Permissions are a policy port, not a pseudo-sandbox

```ts
interface Authorizer {
  readonly authorize: (manifest: Manifest, signal: AbortSignal) => void | Promise<void>;
}
```

`PermissionSet` is an immutable allow-list: allowed entries follow the same non-empty, trimmed identifier rule as Manifest permissions; a Manifest declaring no permissions passes; if any requested permission is missing from the allow-list it throws `PermissionDeniedError` carrying a frozen `denied` list. With no policy supplied, Platform uses an empty `PermissionSet` — that is, it fails closed on every explicit permission request.

Authorization happens at two boundaries:

1. Admission authorization when an Artifact is registered or changed, so a placeholder is authorized before it reaches Core.
2. Authorization again immediately before each real module load, so revocable, interactive or session-dependent policies can still block execution.

An Authorizer decides "may this proceed". It does not rewrite the Context and promises no OS-level isolation. Filesystem, network and window capabilities should still be supplied by application code as minimal Service interfaces; the security boundary is formed jointly by the Loader, execution environment and Service implementations.

`authorize` is strict for the same reason: a policy that understands only a narrower Manifest shape cannot pass type checking and then drop fields or reject otherwise valid Manifests at runtime.

Authorization occurs only at Artifact admission and activation boundaries; it does not intercept each later Core `contribute()`. Per-ExtensionPoint permission is a domain composition policy based on explicit labels in contribution values or restricted Services, not a reason for Platform to duplicate the contribution registry.

## 5. Registration, placeholders and activation

The Artifact:

```ts
interface Artifact<Reference> {
  readonly manifest: ManifestInput | Manifest;
  readonly reference: Reference;
  readonly config?: unknown;
  readonly placeholder?: AnyPlugin;
}
```

An Artifact is also a strict declaration value. It must be a plain record containing only `manifest`, `reference`, `config` and `placeholder`, with `manifest` and `reference` present as enumerable own properties. Unknown fields, symbols, hidden properties, arrays and class instances are rejected when the Artifact enters a ChangeSet. Normalization reads each own field once and returns a frozen value instead of guessing declarations from the prototype chain.

Artifact is an external delivery boundary and does not repeat Core's Plugin authoring generics. A loaded module is outside the type system, so the selected Plugin schema must validate `config` at runtime. `placeholder` uses the same erased `AnyPlugin` shape, allowing a heterogeneous Plugin collection to enter Platform without assertions. Erasure creates no second execution path: both placeholders and loaded Plugins cross the same declaration-normalisation and Core commit boundaries.

A `placeholder` must be created by application-trusted code. It suits contributing command titles, menu metadata or a stand-in panel before lazy loading. Platform installs it as an ordinary Core Plugin at registration; on activation it atomically updates the **same Core Installation** to the loaded Plugin, so the Installation ID, Group membership and downstream observation identity stay stable.

`Registration.status`:

| status | Meaning |
| --- | --- |
| `pending` | still owned by an uncommitted Platform ChangeSet, not yet in the registry |
| `registered` | the Artifact is recorded; no external Plugin selected. A placeholder may already be in Core |
| `loading` | authorizing, activating dependencies or loading the module |
| `activated` | the external Plugin is committed to Core; this does not imply the Host is currently `active` |
| `failed` | the last activation failed; the error is retained for diagnostics and an explicit `activate()` may retry |
| `removed` | removed from both Platform and the Core installation plan; not revivable |

`activate()` can complete while the Host is `idle`: it commits the loaded Plugin into the installation plan and does not secretly start the Host. `status` becomes `"activated"`, but a `ready()` called before or after still waits for `host.start()`. This deliberately separates "the Registration is activated" from "the Instance is ready".

After the signal is aborted, only the exact `signal.reason` or an explicit `AbortError` is classified as a cancellation outcome. Another Loader error that merely occurs after abort remains a `MODULE_LOAD_FAILED` with its original `cause`; a racing cancellation reason never overwrites it.

`ready()` waits for the first activation and the Core ready barrier while `pending` / `registered` / `loading`; delegates to the current Core Installation while `activated`; and rejects immediately while `failed` / `removed`. A failed wait is not revived by a later retry — call `ready()` again after a successful retry.

## 6. Manifest dependencies and activation conditions

`platform.trigger(event)` activates every Registration whose Manifest `activation` contains that string. It attempts all matches; one failure does not cancel unrelated Registrations. A single failure is rethrown as-is; multiple failures throw an `AggregateError`.

Before activating a Registration, Platform activates its Manifest-declared dependencies:

- missing dependency: `REGISTRATION_DEPENDENCY_MISSING`
- version not satisfied: `REGISTRATION_DEPENDENCY_INCOMPATIBLE`
- dependency cycle: `REGISTRATION_CYCLE`

Registration order need not match dependency order: a not-yet-activated Registration may temporarily reference an absent dependency, which lets application code collect a batch of Manifests first. But once every node is present, any closed loop is rejected immediately at the candidate-graph stage of registration or change — Registrations are never left silently pending forever.

Activation of one Registration is serialized. One root activation and its recursive dependencies share an internal permit, so when several consumers concurrently require the same dependency, that dependency completes exactly one effective load. A Platform ChangeSet coordinates with those permits through an activation gate: a failed preflight cancels no in-flight activation; only a successful preflight closes admission for new roots, cancels explicit change targets and awaits already-admitted activation trees. Platform disposal instead becomes terminal and cancels every activation. A load result therefore cannot "revive" an old Artifact across a change boundary.

## 7. Platform ChangeSet

Platform declaration change also has exactly one canonical primitive:

```ts
const change = platform.change();
change.update(provider, providerV2Artifact);
change.update(consumer, consumerV2Artifact);
change.remove(legacy);
const extra = change.register(extraArtifact);
await change.commit();
```

`platform.register()`, `registration.update()` and `registration.remove()` all degenerate mechanically into a single-item Platform ChangeSet. A ChangeSet is one-shot, its commit is idempotent, a target may appear only once, and Registrations from another Platform are rejected.

An empty Platform ChangeSet creates no candidate graph, Core ChangeSet or diagnostics revision, but it still crosses the same command queue in submission order and validates Platform authority. It waits for earlier changes, and an old empty draft created before disposal cannot pretend to commit after the Platform is terminal.

A Registration created by `change.register()` is an exclusive draft of that ChangeSet until commit. It holds no Platform owner, cannot separately `activate` / `update` / `remove`, and cannot be targeted by another ChangeSet. Control authority is granted at commit and revoked again after failure or removal. Direct `remove()` remains idempotent on a terminal handle, but that handle cannot become the target of a new ChangeSet. This keeps both drafts and stale handles from bypassing the candidate graph or retaining the Platform.

Calling `activate()` immediately after `commit()` returns does not depend on microtask order: the Registration first awaits the same admission commit that granted its authority, and both calls observe the same failure if that commit fails.

Commit order:

1. Validate that every target still belongs to this Platform, snapshot which updates enter this transaction as activated, and form the complete candidate graph against the current registry.
2. Against that plan, check duplicate identity, cycles and post-commit activated dependencies, then authorize new or updated Manifests and preload new Plugins for targets planned to remain activated; failure in this phase takes no lock and cancels no activation.
3. Close admission for new root activations, lock and cancel targets being updated or removed, and await every activation tree admitted earlier.
4. Revalidate the candidate against stable Registration state and the same activation plan, so an activation completing during preflight can neither change this update's meaning nor introduce a new activated dependency.
5. Compile placeholder installs, active Plugin updates and removals into **one Core ChangeSet** and commit it.
6. After Core succeeds, switch Platform's Artifacts, Registrations and diagnostic state in one step, then reopen activation admission.

The internal implementation is split along the same boundary: Activator exclusively owns activation trees, permits and change exclusion; the Artifact compiler owns trust validation of the Manifest, placeholder and loaded module; CandidateGraph validates only the complete candidate dependency graph; the CoreChange compiler produces only one Core ChangeSet and its determined final Artifact state. Above those peer collaborators, the Platform coordinator serializes structural commands and prepares an infallible local commit closure before Core commits, so it can never discover a missing Installation or illegal Registration state after Core has already succeeded.

This is what lets a provider go `1.x → 2.x` while a consumer's dependency range goes `^1 → ^2` in a single change; done as two separate `update()` calls, the first illegal candidate graph is rejected. Top-level module import side effects are not transactional, but the installation plan, Core Instances and Registrations never end up half-committed.

If Core rejects an already-prepared update because of config, the Service graph, setup or cleanup failure, the Registration still points at the old Artifact and old Manifest. Core's own rollback / fail-closed semantics decide whether the Installation returns to `active` or the whole Host falls back to `idle`; Platform does not fabricate a second recovery state.

## 8. Groups and application adapters

`createPlatform()` accepts the transaction capability of an installation position through `Pick<Installer, "change">`, so it can bind either a whole Host or a single Group:

```ts
const workspace = host.group("workspace", () => {});
const platform = createPlatform({ installer: workspace, ...options });
```

Placeholder and loaded Plugins installed by Platform belong to that Group; removing the Group removes the whole installation subtree in one Core transaction. A Group is not a capability scope: Services, ExtensionPoints and Events stay Host-wide. Workspace data separation belongs in domain Services and contributions; security isolation belongs in a separate Host, Worker, iframe or process.

Dougong also defines no universal adapter base class. An application adapter is an ordinary capability-providing plugin:

```ts
const filesystemAdapter = definePlugin({
  name: "application.filesystem",
  provides: { filesystem: FILESYSTEM },
  setup: () => ({ filesystem: createRestrictedFilesystem() }),
});

host.install(filesystemAdapter);
```

Planet-style media sources and Lynx Desktop-style commands, menus and panels are ExtensionPoints. Players, filesystems, windows and storage are Services. Workspace and theme changes are Events or signals inside a Service. A domain package may offer modelling helpers closer to the business, but they must expand mechanically onto these primitives.

## 9. Diagnostics, encapsulation and disposal

`platform.diagnostics` uses the same read-only `get() + subscribe()` protocol as Core and signals, and contains:

- Platform `apiVersion`, `status` and a monotonic `revision`
- per Registration: `manifestName`, `version`, `status`, `activation`, `permissions`, `dependencies` and the latest failure, already normalized to `Error`

Each related public type has one role: `Platform` is the control protocol, `PlatformOptions` is its construction boundary, and `PlatformChangeSet` is one structural change. `PlatformStatus` / `PlatformSnapshot` describe aggregate state and diagnostics; `RegistrationStatus` / `RegistrationSnapshot` describe one stable Registration. None exposes the Activator, candidate graph or Core Installation.

The snapshot, entries and arrays are frozen, and the Map exposes no mutating methods. `subscribe()` only delivers future invalidation notices; the caller re-reads with `get()`. A failing diagnostics subscriber is reported through the Platform logger and never changes a registration or activation outcome.

Platform implements no second observer. It submits an immutable PlatformSnapshot to Core's `SnapshotPublisher`. After Platform disposes successfully, an already-obtained historical view stops at the terminal `disposed` state, existing subscriptions detach, and the reader, logger and Platform owner are all severed.

`Registration` and `PlatformChangeSet` are frozen opaque facade objects. Even in JavaScript they leak no internal Artifact, Core Installation, Platform owner or candidate graph; Platform verifies their authority through a private WeakMap.

Once a Registration reaches `removed`, its control authority is revoked and the Artifact reference, config and Platform owner are released — holding a terminal Registration never keeps the whole Platform alive. `remove()` then still succeeds idempotently while `activate` / `update` reject with `REGISTRATION_REMOVED`, matching Core's terminal `Installation` semantics.

Platform owns every Registration:

```ts
await platform.dispose();
// await using / Symbol.asyncDispose are supported too
```

Disposal is a terminal command on the same change queue: it first forbids new operations and new draft authority, waits for preceding changes, cancels in-flight loads, then removes every Core Installation atomically through one Core ChangeSet. On success Platform enters `disposed` and every Registration enters `removed`; repeated disposal is idempotent. If Core cleanup fails, Platform returns to `active` and throws the error to the caller rather than falsely reporting that it was released.

Successful disposal also severs the Installer, Loader, Authorizer, Logger ports and the shared draft authority. A ChangeSet created earlier but never committed will thereafter reject with `PLATFORM_UNAVAILABLE`; its draft Registrations enter `failed` and release their Artifacts, so retaining them cannot keep the Host alive.

The recommended ownership order is to dispose the Platform first and then remove its bound Group. If application code removes the Group first, Platform recognises Installations that Core has already removed and still completes its own disposal idempotently, without trying to create another empty change through a removed Group.

## 10. Stable error codes

Platform's decidable errors use `PlatformError.code`. `PlatformError extends DougongError`, so application code can either catch every Dougong-layer error uniformly or handle only delivery-layer errors:

| code | Meaning |
| --- | --- |
| `MANIFEST_INVALID` | Manifest shape, semver or range is illegal |
| `API_INCOMPATIBLE` | The application API range the Manifest requires does not match |
| `PERMISSION_DENIED` | The permission policy refused; the concrete type is `PermissionDeniedError` |
| `REGISTRATION_DUPLICATE` | A duplicate identity appeared in the candidate Registration graph |
| `ARTIFACT_IDENTITY` | Manifest, placeholder or loaded Plugin names disagree |
| `REGISTRATION_IDENTITY` | An update's Artifact carries a different Manifest name |
| `REGISTRATION_DEPENDENCY_MISSING` | An activated or activating Registration has no Registration for a manifest dependency |
| `REGISTRATION_DEPENDENCY_INCOMPATIBLE` | A dependency Registration does not satisfy the manifest version range |
| `REGISTRATION_DEPENDENCY_INACTIVE` | An activated candidate Registration depends on a Registration that is not activated |
| `REGISTRATION_CYCLE` | Manifest dependencies form a cycle in the candidate Registration graph |
| `REGISTRATION_BUSY` | The target is changing, or a structural change has closed admission for new root activations |
| `MODULE_LOAD_FAILED` | The loader itself failed |
| `MODULE_INVALID` | The module or its default export is not a valid Plugin |
| `REGISTRATION_REMOVED` | An operation on a removed Registration |
| `REGISTRATION_UNAVAILABLE` | The Registration is uncommitted or unavailable; when activation / admission throws a non-`Error` value, the first public command and `ready()` use the same classification. An uncommitted terminal Registration keeps only an error summary, so a later `ready()` reconstructs an equivalent error without retaining the original Error stack |
| `PLATFORM_UNAVAILABLE` | The Platform is disposing or already disposed |

Error messages are for humans; they are not a stable parsing protocol. Programming-shape errors, cross-Platform Registrations, duplicate ChangeSet targets and modification after submission use `TypeError`; a custom Installer rejecting with a non-`Error` value is also classified at the Platform command boundary as a `TypeError` carrying the original `cause`.
