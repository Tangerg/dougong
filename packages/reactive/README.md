# @dougongjs/reactive

Independent synchronous signals and structurally owned reactive generations. No external runtime dependencies.

Upgrading from 0.8.3? Read the [migration guide](https://tangerg.github.io/dougong/en/guide/migrating-to-0.9) and [0.9.0 release notes](https://tangerg.github.io/dougong/en/reference/release-0.9.0).

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

`observe(owner, readable, observer)` disposes the previous child before building the next one. The structural owner supplies `child`, `defer` and `spawn`; only the returned child needs `Symbol.asyncDispose`; no framework base class is required. Use `generation.spawn` for asynchronous observer work.

ESM; Node.js `^24.22.0 || >=26.10.0`, Chrome/Edge 119+, Firefox 124+, Safari 17.4+.

[Guide](https://tangerg.github.io/dougong/en/guide/reactive)
