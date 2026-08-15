# Dougong Platform specification

`@dougongjs/platform` compiles an external plugin's manifest, loading, version constraints, activation policy and permission decisions into ordinary `@dougongjs/core` plugins and ChangeSets. It is not a second plugin runtime: the Service graph, Lifetimes, Group ownership, rollback and the final truth about instance state remain in Core alone.

This document describes Platform's observable contract. For Core primitives see the [Core API specification](./core-api.md); for the layering rationale see [Architecture](./architecture.md); for a user-facing introduction see [External plugin delivery](../guide/platform.md).

## 1. Mental model

Platform adds exactly four concepts:

```text
Manifest       static identity, compatibility range, activation conditions, permission requests
Artifact       manifest + module reference + config + optional placeholder definition
Registration  the stable managed identity of one external plugin
Platform       owner of the registry, load policy, permission policy and atomic change
```

Typical use:

```ts
const platform = createPlatform({
  installer: app,
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  permissions: new PermissionSet(["network"]),
});

const plugin = await platform.register({
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
await plugin.ready();
```

`register()` only admits the Artifact into the platform; `activate()` selects and loads its external implementation; `ready()` waits for the corresponding Core installation to actually cross the Host / ChangeSet ready barrier. These three are not synonyms.

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
- A manifest is a strict object: unknown fields are rejected rather than silently dropping a misspelled option.
- No activation condition or permission may repeat.
- The returned object, arrays and dependency map are frozen. A manifest is a value; it holds no runtime state.
- The plugin `name` is the Platform identity and must match the `Plugin.name` of both the placeholder and the loaded module exactly.

`apiVersion` constrains the Dougong/domain API the application exposes to plugins; it is not the plugin's own version. `dependencies` constrains other manifests' versions. Real runtime capability dependencies must still be written into Core `requires` — manifest dependencies are not a bypass around the Service graph.

## 3. The loader is the execution boundary

```ts
interface Loader<Reference> {
  load(reference: Reference, signal: AbortSignal): unknown | Promise<unknown>;
}
```

A loaded module must expose exactly one `Plugin` as its `default` export. Platform re-runs `definePlugin()`'s structural validation after loading and verifies the name. Loader failures are wrapped as `PlatformError` with `MODULE_LOAD_FAILED`; a bad module shape or default export uses `MODULE_INVALID`.

Built-in implementations:

- `ImportLoader` — dynamic `import()`, for trusted same-realm ESM. Explicitly **not a sandbox**.
- `MemoryLoader` — reads modules from an application-supplied read-only Map, for embedded bundles, deterministic tests and application built-in plugins.

A loader must check its `AbortSignal` during expensive phases. Platform also re-checks after the loader returns, so an uncooperative loader cannot commit a module into Core after cancellation — but the I/O and module top-level side effects it already performed cannot be undone.

Untrusted plugins belong in a Worker, iframe, separate process or restricted realm. The corresponding loader can return a **application-authored RPC proxy `Plugin`** that maps granted capabilities onto ordinary Services. What you cannot do is `import()` arbitrary code into the host realm first and then expect context permissions to make it safe.

## 4. Permissions are a policy port, not a pseudo-sandbox

```ts
interface Authorizer {
  authorize(manifest: Manifest, signal: AbortSignal): void | Promise<void>;
}
```

`PermissionSet` is an immutable allow-list: a plugin requesting no permissions passes; if any requested permission is missing from the allow-list it throws `PermissionDeniedError` carrying a frozen `denied` list. With no policy supplied, Platform uses an empty `PermissionSet` — that is, it fails closed on every explicit permission request.

Authorization happens at two boundaries:

1. Admission authorization when an Artifact is registered or changed, so a placeholder is authorized before it reaches Core.
2. Authorization again immediately before each real module load, so revocable, interactive or session-dependent policies can still block execution.

An authorizer decides "may this proceed". It does not rewrite the context and promises no OS-level isolation. Filesystem, network and window capabilities should still be supplied by the host as minimal Service interfaces; the security boundary is formed jointly by the loader / execution environment and the Service implementations.

## 5. Registration, placeholders and activation

The Artifact:

```ts
interface Artifact<Reference> {
  readonly manifest: ManifestInput | Manifest;
  readonly reference: Reference;
  readonly config?: unknown; // required by type when ConfigInput is not void
  readonly placeholder?: Plugin;
}
```

A `placeholder` must be created by application-trusted code. It suits contributing command titles, menu metadata or a stand-in panel before lazy loading. Platform installs it as an ordinary Core plugin at registration; on activation it atomically updates the **same Core handle** to the loaded definition, so the installation ID, Group membership and downstream observation identity stay stable.

`Registration.status`:

| status | Meaning |
| --- | --- |
| `pending` | still owned by an uncommitted Platform ChangeSet, not yet in the registry |
| `registered` | the Artifact is recorded; no external implementation selected. A placeholder may already be in Core |
| `loading` | authorizing, activating dependencies or loading the module |
| `activated` | the external definition is committed to Core; this does not imply the Host is currently `active` |
| `failed` | the last activation failed; the error is retained for diagnostics and an explicit `activate()` may retry |
| `removed` | removed from both Platform and the Core installation plan; not revivable |

`activate()` can complete while the Host is `idle`: it commits the definition into the installation plan and does not secretly start the Host. `status` becomes `"activated"`, but a `ready()` called before or after still waits for `host.start()`. This deliberately separates "the module is activated" from "the running instance is ready".

`ready()` waits for the first activation and the Core ready barrier while `pending` / `registered` / `loading`; delegates to the current Core handle while `activated`; and rejects immediately while `failed` / `removed`. A failed wait is not revived by a later retry — call `ready()` again after a successful retry.

## 6. Manifest dependencies and activation conditions

`platform.trigger(event)` activates every plugin whose manifest `activation` contains that string. It attempts all matches; one failure does not cancel unrelated plugins. A single failure is rethrown as-is; multiple failures throw an `AggregateError`.

Before activating a plugin, Platform activates its manifest-declared dependencies:

- missing dependency: `PLUGIN_DEPENDENCY_MISSING`
- version not satisfied: `PLUGIN_DEPENDENCY_INCOMPATIBLE`
- dependency cycle: `PLUGIN_CYCLE`

Registration order need not match dependency order: a not-yet-activated plugin may temporarily reference an unregistered dependency, which lets a host collect a batch of manifests first. But once every node is present, any closed loop is rejected immediately at the candidate-graph stage of registration or change — plugins are never left silently pending forever.

Activation of one Registration is serialized. When several consumers concurrently require the same dependency, that dependency completes exactly one effective load. Update, removal and Platform disposal cancel and await the relevant activations, so a load result can never "revive" an old Artifact across a change boundary.

## 7. Platform ChangeSet

Platform declaration change also has exactly one canonical primitive:

```ts
const change = platform.change();
change.update(provider, providerV2Artifact);
change.update(consumer, consumerV2Artifact);
change.remove(legacyPlugin);
const extra = change.register(extraArtifact);
await change.commit();
```

`platform.register()`, `managed.update()` and `managed.remove()` all degenerate mechanically into a single-item Platform ChangeSet. A ChangeSet is one-shot, its commit is idempotent, a target may appear only once, and handles from another Platform are rejected.

An empty Platform ChangeSet commits as a side-effect-free no-op: no candidate graph, no Core ChangeSet, no diagnostics revision.

A Registration created by `change.register()` is only that ChangeSet's draft until commit. It holds no Platform owner and cannot separately `activate` / `update` / `remove`. Control authority is granted at commit and revoked again if registration fails. This keeps drafts from bypassing the candidate graph, and keeps a forgotten uncommitted handle from keeping the Platform alive.

Commit order:

1. Lock and cancel in-flight activations for targets being updated or removed.
2. Apply all operations once against the current registry to form the candidate manifest graph.
3. Check duplicate identity and dependency cycles; for plugins that remain activated in the end, require every dependency to exist, be version-compatible and already be activated.
4. Authorize new and updated manifests.
5. Preload new definitions for all activated targets — any failure here has still not touched Core.
6. Compile placeholder installs, active definition updates and removals into **one Core ChangeSet** and commit it.
7. After Core succeeds, switch Platform's Artifacts, handles and diagnostic state in one step.

The internal implementation is split along the same boundary: the Artifact compiler handles trust validation of manifest, placeholder and loaded module; CandidateGraph validates only the complete candidate dependency graph; the CoreChange compiler produces only one Core ChangeSet and its determined final Artifact state. The Platform coordinator prepares an infallible local commit closure before Core commits, so it can never discover a missing handle or illegal registration state after Core has already succeeded.

This is what lets a provider go `1.x → 2.x` while a consumer's dependency range goes `^1 → ^2` in a single change; done as two separate `update()` calls, the first illegal candidate graph is rejected. Top-level module import side effects are not transactional, but the installation plan, Core runtime instances and Platform records never end up half-committed.

If Core rejects an already-prepared update because of config, the service graph, setup or cleanup failure, the Registration still points at the old Artifact and old manifest. Core's own rollback / fail-closed semantics decide whether running instances return to `active` or the whole Host falls back to `idle`; Platform does not fabricate a second recovery state.

## 8. Groups and application adapters

`createPlatform()` accepts a `Installer`, so it can bind either a whole Host or a single Group:

```ts
const workspace = host.group("workspace", () => {});
const platform = createPlatform({ installer: workspace, ...options });
```

Placeholders and active definitions installed by Platform belong to that Group; removing the Group removes the whole installation subtree in one Core transaction. A Group is not a capability scope: Services, ExtensionPoints and Events stay globally consistent within one Host. Workspace data separation belongs in domain Services and contributions; security isolation belongs in a separate Host, Worker, iframe or process.

Dougong also defines no universal adapter base class. An application adapter is an ordinary capability-providing plugin:

```ts
const filesystemAdapter = definePlugin({
  name: "host.filesystem",
  provides: { filesystem: FILESYSTEM },
  setup: () => ({ filesystem: createRestrictedFilesystem() }),
});

host.install(filesystemAdapter);
```

Planet-style media sources and Lynx Desktop-style commands, menus and panels are ExtensionPoints. Players, filesystems, windows and storage are Services. Workspace and theme changes are Events or signals inside a Service. A domain package may offer modelling helpers closer to the business, but they must expand mechanically onto these primitives.

## 9. Diagnostics, encapsulation and disposal

`platform.diagnostics` uses the same read-only `get() + subscribe()` protocol as Core and signals, and contains:

- Platform `apiVersion`, `status` and a monotonic `revision`
- per registered plugin: name, version, status, activation, permissions, dependencies and the most recent error

The snapshot, entries and arrays are frozen, and the Map exposes no mutating methods. `subscribe()` only delivers future invalidation notices; the caller re-reads with `get()`. A failing diagnostics subscriber is reported through the Platform logger and never changes a registration or activation outcome.

Platform implements no second observer. It submits an immutable PlatformSnapshot to Core's `SnapshotPublisher`. After Platform disposes successfully, an already-obtained historical view stops at the terminal `disposed` state, existing subscriptions detach, and the reader, logger and Platform owner are all severed.

`Registration` and `PlatformChangeSet` are frozen opaque handles. Even at the JavaScript runtime they leak no internal Artifact, Core handle, Platform owner or candidate graph; Platform verifies handle authority through a private WeakMap.

Once a handle reaches `removed`, its control authority is revoked and the Artifact reference, config and Platform owner are released — holding a terminal handle never keeps the whole Platform alive. `remove()` then still succeeds idempotently while `activate` / `update` reject with `REGISTRATION_REMOVED`, matching Core's terminal `Installation` semantics.

Platform owns every Registration:

```ts
await platform.dispose();
// await using / Symbol.asyncDispose are supported too
```

Disposal first forbids new operations and cancels in-flight loads, then removes every Core handle atomically through one Core ChangeSet. On success Platform enters `disposed` and every Registration enters `removed`; repeated disposal is idempotent. If Core cleanup fails, Platform returns to `active` and throws the error to the caller rather than falsely reporting that it was released.

Successful disposal also severs the installer, loader, permission, logger ports and the shared draft authority. A ChangeSet created earlier but never committed will thereafter reject with `PLATFORM_UNAVAILABLE`, its draft handles enter `failed` and release their Artifacts — they cannot keep the host Host alive by being retained.

The recommended ownership order is to dispose the Platform first and then remove its bound Group. If the host removed the Group first, Platform recognises handles that Core has already removed and still completes its own disposal idempotently, without trying to create another empty change through a dead Group.

## 10. Stable error codes

Platform's decidable errors use `PlatformError.code`. `PlatformError extends DougongError`, so a host can either catch every Dougong-layer error uniformly or handle only delivery-layer errors:

| code | Meaning |
| --- | --- |
| `MANIFEST_INVALID` | Manifest shape, semver or range is illegal |
| `API_INCOMPATIBLE` | The host API range the plugin requires does not match |
| `PERMISSION_DENIED` | The permission policy refused; the concrete type is `PermissionDeniedError` |
| `PLUGIN_DUPLICATE` | A duplicate name appeared in the candidate registry |
| `REGISTRATION_IDENTITY` | Manifest, placeholder or loaded definition names disagree |
| `PLUGIN_DEPENDENCY_MISSING` | An activated or activating plugin lacks a manifest dependency |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | A manifest dependency version is not satisfied |
| `PLUGIN_DEPENDENCY_INACTIVE` | An activated candidate depends on a plugin that is not activated |
| `PLUGIN_CYCLE` | The manifest dependency graph contains a closed loop |
| `REGISTRATION_BUSY` | Activation raced a declaration change on the same target |
| `MODULE_LOAD_FAILED` | The loader itself failed |
| `MODULE_INVALID` | The module or its default export is not a valid plugin definition |
| `REGISTRATION_REMOVED` | An operation on a removed Registration |
| `REGISTRATION_UNAVAILABLE` | The fallback state in which `ready()` cannot wait |
| `PLATFORM_UNAVAILABLE` | The Platform is disposing or already disposed |

Error messages are for humans; they are not a stable parsing protocol. Programming-shape errors, cross-Platform handles, duplicate ChangeSet targets and modification after submission use `TypeError`.
