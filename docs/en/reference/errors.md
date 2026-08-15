# Error codes

Every structured error Dougong throws carries a stable `code` string. Application code should branch on `error.code` rather than matching message text — messages change, codes do not.

## The naming rule

A code names **which object's invariant was violated**, instead of vaguely saying "a plugin failed":

| Prefix | The object whose invariant broke | Package |
| --- | --- | --- |
| `SERVICE_*` / `CONTRACT_*` / `CONFIG_*` | Contract identity, the dependency graph, a config declaration | Core |
| `INSTALLATION_*` | One existing installation | Core |
| `GROUP_*` | One installation-ownership subtree | Core |
| `PLUGIN_*` | The Plugin declaration itself, or the plugin dependencies a manifest declares | Platform |
| `ARTIFACT_*` | One external artifact that disagrees with itself | Platform |
| `REGISTRATION_*` | One existing registration record | Platform |
| `MANIFEST_*` / `MODULE_*` / `API_*` / `PERMISSION_*` / `PLATFORM_*` | The trust and loading boundaries | Platform |

So `INSTALLATION_REMOVED` is a Core installation and `REGISTRATION_REMOVED` is a Platform registration — no need to open the implementation to learn which layer you are in.

## Error types

```ts
class DougongError extends Error {
  readonly code: string
}

class ConfigValidationError extends DougongError {   // code: "CONFIG_INVALID"
  readonly issues: ReadonlyArray<ValidationIssue>
}

class PlatformError extends DougongError {}

class PermissionDeniedError extends PlatformError {  // code: "PERMISSION_DENIED"
  readonly plugin: string
  readonly denied: ReadonlyArray<string>
}
```

Several failures are aggregated into a standard `AggregateError`, with every cause preserved in `errors`.

::: tip TypeError versus Error
Beyond coded errors, Dougong uses two native types:

- **`TypeError`** — the caller passed the wrong thing (not a function, not a Contract, a key conflict, an operation on a released object)
- **`Error`** — an internal invariant broke; that is a framework bug you should never reach in normal use

So you can branch by constructor: a `DougongError` is an expected runtime failure, a `TypeError` is a usage problem.
:::

## Core (`@dougongjs/core`)

### Graph construction

These are thrown **before any plugin starts**. The running graph has not moved.

| Code | Trigger |
| --- | --- |
| `SERVICE_CYCLE` | A dependency cycle. The message carries the real path: `app.a:1 -> app.b:2 -> app.a:1`. A plugin requiring a Service it provides counts too |
| `SERVICE_CONFLICT` | Two plugins provide the same Service |
| `SERVICE_MISSING` | A required Service has no provider (an `optional()` declaration does not count) |
| `CONTRACT_CONFLICT` | The same Contract ID is used as two different kinds |
| `CONFIG_INVALID` | Config failed Standard Schema validation. `error.issues` lists the problems per field |

::: warning Validation precedes shutdown
Every affected plugin's config is validated in full before any running instance is stopped. One misspelled field cannot leave the application halfway down.
:::

### Startup and runtime

| Code | Trigger |
| --- | --- |
| `SERVICE_NOT_RETURNED` | `provides` declared a key that the `setup` return value does not contain |
| `SERVICE_UNAVAILABLE` | `host.get()` was called outside `active`; or the depended-on Service's installation is not active |
| `INSTALLATION_UNAVAILABLE` | The installation is `failed`; or setup threw a **non-Error** value (the original is in `cause`); or an operation ran on an uncommitted draft |
| `INSTALLATION_REMOVED` | An operation on a removed Installation |
| `INSTALLATION_IDENTITY` | `update()` tried to change the Plugin name. An update may swap implementation and config, never identity |

### Group

| Code | Trigger |
| --- | --- |
| `GROUP_REMOVED` | An operation on a removed Group |
| `GROUP_UNAVAILABLE` | The Group was never established; or a Group operation failed with a non-Error value |

## Platform (`@dougongjs/platform`)

### Trust boundary

Thrown **before** any external module code is loaded.

| Code | Trigger |
| --- | --- |
| `MANIFEST_INVALID` | The manifest shape is illegal, or it declares duplicate activation events / permissions / dependencies |
| `API_INCOMPATIBLE` | The plugin's required `apiVersion` does not satisfy the application version |
| `PERMISSION_DENIED` | The Authorizer refused. `error.denied` lists the refused permissions |
| `PLUGIN_DUPLICATE` | Two artifacts declare the same Plugin name |

### Manifest dependency resolution

These describe the **plugin dependencies a manifest declares**, so they stay `PLUGIN_*`.

| Code | Trigger |
| --- | --- |
| `PLUGIN_DEPENDENCY_MISSING` | A manifest dependency is not registered |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | The dependency is registered but outside the version range |
| `PLUGIN_DEPENDENCY_INACTIVE` | The dependency exists but could not activate |
| `PLUGIN_CYCLE` | Manifest dependencies form a cycle. The message carries the real path |

### Loading and activation

| Code | Trigger |
| --- | --- |
| `MODULE_LOAD_FAILED` | The loader threw. The original error is in `cause` |
| `MODULE_INVALID` | The module loaded but exports no valid Plugin |
| `ARTIFACT_IDENTITY` | One artifact disagrees with itself: the manifest name differs from the placeholder's or the loaded Plugin's name |
| `REGISTRATION_BUSY` | That Registration already has a change in flight |
| `REGISTRATION_UNAVAILABLE` | The Registration is unavailable, or an operation ran on an uncommitted registration |
| `REGISTRATION_REMOVED` | An operation on a removed Registration |
| `REGISTRATION_IDENTITY` | An update's new artifact carries a different manifest name |
| `PLATFORM_UNAVAILABLE` | The Platform is disposed, or in a state that forbids the operation |

::: tip The three IDENTITY codes
They describe identity invariants on three different objects:

- **`INSTALLATION_IDENTITY`** — an existing Installation tried to change its Plugin name (Core)
- **`REGISTRATION_IDENTITY`** — an existing Registration tried to change its manifest name (Platform)
- **`ARTIFACT_IDENTITY`** — one artifact's manifest disagrees with the Plugin it loads (Platform, where a Registration may not exist yet)
:::

## Handling them

### Branch on the code

```ts
try {
  await installation.ready()
} catch (error) {
  if (!(error instanceof DougongError)) throw error

  switch (error.code) {
    case "CONFIG_INVALID":
      showFieldErrors((error as ConfigValidationError).issues)
      break
    case "SERVICE_MISSING":
      suggestInstallDependency(error.message)
      break
    case "INSTALLATION_UNAVAILABLE":
      offerRetry()
      break
    default:
      report(error)
  }
}
```

### Handle aggregates

```ts
try {
  await host.stop()
} catch (error) {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) report(cause)
  }
}
```

### Receive background errors

Exceptions from background tasks, listeners and diagnostic subscribers never interrupt a runtime command; they arrive through the Host's reporting channel:

```ts
const host = createHost({
  name: "app",
  onError: (error) => reportToSentry(error),
  logger: myLogger,          // fallback when onError is absent or itself throws
})
```

The channel is fail-safe: a throwing `onError` falls back to the logger, and a throwing logger falls silent — **observing an error never changes the runtime command being observed**.

### How much a terminal failure retains

Once an Installation detaches from its Host (removed or discarded), it keeps only a plain-data summary of the error — `name` / `message` / `code` — and rebuilds an Error when read.

The reason is that JavaScript's `Error.stack` can carry the whole orchestration call frame from where the error was created, letting one historical object keep an entire Host alive.

**The normal path is unaffected**: a caller awaiting `ready()` always receives the original `Error`, and a failed instance still attached to a live Host keeps its original error too. Only an after-the-fact read of a detached instance whose caller never awaited `ready()` gets the summary — and there subclass data such as `ConfigValidationError.issues` is no longer available.

## Related

- [Core API specification · Error conventions](./core-api.md)
- [Platform specification · Stable error codes](./platform.md)
- [Transactions and change](../guide/transactions.md) — the three-level failure model
