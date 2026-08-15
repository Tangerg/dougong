# Error codes

Every structured error Dougong throws carries a stable `code` string. Hosts should branch on `error.code` rather than matching message text — messages change, codes do not.

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

Multiple failures aggregate into a standard `AggregateError`, with every cause retained in `errors`.

::: tip TypeError vs Error
Besides coded errors, Dougong uses two native types:

- **`TypeError`** — the caller passed something wrong (not a function, not a Contract, a key conflict, an operation on a released object)
- **`Error`** — an internal invariant was violated; that is a framework bug you should not hit in normal use

So you can branch by constructor: a `DougongError` is an expected runtime failure, a `TypeError` is a usage problem.
:::

## Core (`@dougongjs/core`)

### Graph time

These are thrown **before any plugin starts**. The runtime graph has not moved.

| Code | Condition |
| --- | --- |
| `SERVICE_CYCLE` | A dependency cycle. The message carries the real path: `app.a:1 -> app.b:2 -> app.a:1`. A plugin requiring a Service it provides itself also counts |
| `SERVICE_CONFLICT` | Two plugins provide the same Service |
| `SERVICE_MISSING` | A required Service has no provider (`optional()` declarations excluded) |
| `CONTRACT_CONFLICT` | One Contract ID used as two kinds |
| `CONFIG_INVALID` | Config failed its Standard Schema. `error.issues` lists the problems per field |

::: warning Validation precedes shutdown
Every affected plugin's config is validated before any running instance is stopped. A misspelled field never leaves the application halfway down.
:::

### Startup and runtime

| Code | Condition |
| --- | --- |
| `SERVICE_NOT_RETURNED` | `provides` declares a key that `setup`'s return value omits |
| `SERVICE_UNAVAILABLE` | `app.get()` called outside `active`; or a required Service's owning plugin is not active |
| `PLUGIN_UNAVAILABLE` | The plugin is `failed`; or setup threw a **non-Error** value (kept in `cause`); or an operation on an uncommitted draft |
| `PLUGIN_REMOVED` | An operation on a removed plugin handle |
| `PLUGIN_IDENTITY` | `update()` attempted to change the plugin name. An update may swap implementation and config, never identity |

### Group

| Code | Condition |
| --- | --- |
| `GROUP_REMOVED` | An operation on a removed Group handle |
| `GROUP_UNAVAILABLE` | The Group was never successfully established; or a Group operation failed with a non-Error value |

## Platform (`@dougongjs/platform`)

### Trust boundary

Thrown **before** any external module code is loaded.

| Code | Condition |
| --- | --- |
| `MANIFEST_INVALID` | Malformed manifest, or duplicate activation events / permissions / dependencies |
| `API_INCOMPATIBLE` | The plugin's required `apiVersion` does not match the host |
| `PERMISSION_DENIED` | The authorizer refused. `error.denied` lists the refused permissions |
| `PLUGIN_DUPLICATE` | A plugin with that name is already registered |

### Dependency resolution

| Code | Condition |
| --- | --- |
| `PLUGIN_DEPENDENCY_MISSING` | A manifest dependency is not registered |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | Registered but outside the version range |
| `PLUGIN_DEPENDENCY_INACTIVE` | Present but failed to activate |
| `PLUGIN_CYCLE` | Manifest dependencies form a cycle; the message carries the real path |

### Loading and activation

| Code | Condition |
| --- | --- |
| `MODULE_LOAD_FAILED` | The loader threw. The original error is in `cause` |
| `MODULE_INVALID` | The module loaded but exports no valid plugin definition |
| `PLUGIN_BUSY` | A change is already in flight for that plugin |
| `PLUGIN_IDENTITY` | An update's manifest name differs from the existing plugin's; or the manifest name does not match the definition the module exports |
| `PLATFORM_UNAVAILABLE` | The Platform is disposed, or in a state that forbids the operation |

## Handling them

### Branch on code

```ts
try {
  await handle.ready()
} catch (error) {
  if (!(error instanceof DougongError)) throw error

  switch (error.code) {
    case "CONFIG_INVALID":
      showFieldErrors((error as ConfigValidationError).issues)
      break
    case "SERVICE_MISSING":
      suggestInstallDependency(error.message)
      break
    case "PLUGIN_UNAVAILABLE":
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
  await app.stop()
} catch (error) {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) report(cause)
  }
}
```

### Receive background errors

Exceptions from background tasks, listeners and diagnostic subscribers never interrupt the runtime command that is executing. They travel through the Application's reporting channel:

```ts
const app = createApp({
  name: "app",
  onError: (error) => reportToSentry(error),
  logger: myLogger,          // fallback when onError is absent or itself throws
})
```

The reporting channel is fail-safe: if `onError` throws it falls back to the logger, and if the logger throws it goes silent — **error observation must never mutate the runtime command being observed.**

### How much a terminal failure retains

Once an installation detaches from the Application (removed or discarded), its handle keeps only a `name` / `message` / `code` data summary and reconstructs an `Error` on read.

The reason is that a JavaScript `Error.stack` can carry the entire orchestration frame that created it, letting a historical handle keep the whole Application alive.

**This does not affect the normal path**: callers awaiting `ready()` always receive the original `Error`, and failed instances still belonging to a live Application keep the original too. Only a read made after the instance has detached, by a caller that never awaited `ready()`, sees the summary — at which point subclass data such as `ConfigValidationError.issues` is no longer available.

## Related

- [Core API specification · error conventions](./core-api.md)
- [Platform specification · stable error codes](./platform.md)
- [Transactions and change](../guide/transactions.md) — the three-level failure model
