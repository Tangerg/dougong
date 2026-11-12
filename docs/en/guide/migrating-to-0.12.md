# Migrating from 0.11 to 0.12.0

Upgrade the `dougong`, `@dougongjs/platform` and `@dougongjs/reactive` packages used by your application to 0.12.0 together, then run application type checks and integration tests. The [release notes](../reference/release-0.12.0.md) describe the full scope.

## Declare the resource identity domain

`createHost` no longer accepts omitted options, and `HostOptions.resourceAuthority` is required. Create one authority for each resource-sharing domain; Hosts and Core copies sharing resources use that same object.

```ts
import { createHost, createResourceAuthority } from "dougong";

const resourceAuthority = createResourceAuthority();
const application = createHost({ resourceAuthority, name: "application" });
const preview = createHost({ resourceAuthority, name: "preview" });
```

The authority arbitrates resource identity reservations and control handle provenance. Lifetime still owns actual release. Sharing an authority does not allow two Hosts to adopt the same resource. Different authorities declare independent domains; pass usage across domains while leaving release with the original owner. Do not create another adoption path for the same resource. See [Lifetime and resources](./lifetime.md).

## Preserve the complete plugin authoring contract

Check declarations with `definePlugin` or an explicit `Plugin<...>` annotation before installation or replacement. Unchecked raw objects no longer serve as static installation declarations. If a spread changes an existing Plugin's `requires`, `provides`, schema or setup, call `definePlugin` again to check the complete result.

`requires` and `provides` declare finite, definite, required string aliases. A nonempty map requires its corresponding field; setup annotations and return values cannot invent omitted declarations. Define complete Plugins before choosing between them instead of combining a union of provision maps with an independently selected setup. Without a schema, configuration input must be assignable to setup's configuration output; type parameters cannot stand in for a transformation.

Loaders handling unknown modules use `capturePluginDeclaration` from `dougong/advanced` to obtain a runtime-checked `AnyPlugin` with explicitly erased authoring types. Do not assert an unknown module into a checked Plugin. See [Writing plugins](./writing-plugins.md).

## Integrate cancellation and restoration waiting

`host.start(signal)` and `host.apply(plan, signal)` accept an optional AbortSignal. Existing calls without a signal remain valid. Set `restorationTimeoutMilliseconds` when restoration preparation needs a waiting limit.

Cancellation moves execution into recovery; it does not prove that non-cooperative setup or resource release has finished. Cleanup or restoration that cannot establish a healthy state permanently quarantines the Host, retaining original obligations without automatic cleanup retries. Plans remain Host-bound, revision-bound and single-use. See [Transactions and change](./transactions.md).

## Check adapter result and release protocols

Local native Promises are observed through intrinsic `then`. Decorating their public `then` cannot replace actual settlement, and `Symbol.toStringTag` no longer selects the protocol. Foreign-realm and structural thenables use one captured public `then` with its original receiver. A `constructor` or `Symbol.species` failure that prevents intrinsic observation propagates without switching protocols. See the guarantee boundaries in [Lifetime and resources](./lifetime.md).

Synchronous protocols cannot return Promises. Adapters can apply the same boundary check with the new `assertSynchronous` export from `dougong/advanced`. ResourceAuthority methods and claim-release callbacks must also finish synchronously. Internal contribution views and subscriptions belong directly to synchronous Lifetime cleanup records: they register control provenance without requesting an external resource claim.

A failed Host diagnostic read is an observation failure. It cannot replace a committed Platform selection or activation outcome, or prevent disposal from cancelling admitted work. Failed subscription withdrawal retains the failed disposal receipt; repeated disposal does not retry it. See the [Platform specification](../reference/platform.md).
