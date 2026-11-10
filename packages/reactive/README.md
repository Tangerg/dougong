# @dougongjs/reactive

Independent synchronous signals and structurally owned reactive generations. No external runtime dependencies.

Read the [upgrade guide](https://tangerg.github.io/dougong/en/guide/upgrading) for migration steps and release notes for your target version.

```ts
import { batch, computed, disposeSymbol, signal } from "@dougongjs/reactive";

const first = signal("Dougong");
const last = signal("Plugins");
const title = computed(() => `${first.get()} ${last.get()}`);
const subscription = title.subscribe(() => render(title.get()));
batch(() => {
  first.set("Typed");
  last.set("Composition");
});
subscription[disposeSymbol]();
```

`Readable<T>` exposes `get()` and `subscribe()`. The subscription implements standard `Symbol.dispose`; callbacks notify changes without replay. `bridge(owner, readable)` adapts another module copy or implementation into the local dependency graph. Its subscription and terminal detachment belong to the supplied owner through `defer`.

`batch`, `computed`, `subscribe` and `observe` require synchronous callbacks in both their types and runtime checks. Direct Promise results, PromiseLike results and mixed asynchronous branches are rejected, including when a caller explicitly supplies `void`. Ordinary synchronous return values remain inferred; `Observer<T, Child, Result>` can describe an explicit non-void result. Values whose type was already erased still receive the runtime check.

`observe(owner, readable, observer)` disposes the previous child before building the next one. The structural owner supplies `child`, `defer` and `spawn`; only the returned child needs `Symbol.asyncDispose`; no framework base class is required. Use `generation.spawn` for asynchronous observer work.

`ObservationTask` describes completion only: it is not generic, and its `result` is `PromiseLike<unknown>`. The required `spawn` accepts a task returning `void | PromiseLike<void>`. Owners may provide a richer generic task API without coupling observation to their result payloads.

Results inheriting this module's realm's `Promise.prototype` select the intrinsic native protocol, including decorated local Promises and subclasses. Other results use one captured structural `then`; display tags do not select a protocol. Foreign Promises must expose a conforming public `then`. Adapt decorated foreign results in their origin realm, and box payloads there when another assimilation would change them. See the guide for the precise boundary and disposal guarantees.

ESM; <!-- runtime-baseline:start -->Node.js `^24.22.0 || >=26.10.0`, Chrome ≥ 119, Edge ≥ 119, Firefox ≥ 124, Safari ≥ 17.4<!-- runtime-baseline:end -->.

[Guide](https://tangerg.github.io/dougong/en/guide/reactive)
