# @dougongjs/reactive

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

**零依赖**的响应式原语：`signal` / `computed` / `batch` / `observe`。

```sh
npm install @dougongjs/reactive
```

```ts
import { signal, computed, batch, observe } from "@dougongjs/reactive"

const count = signal(0)
const double = computed(() => count.get() * 2)

batch(() => count.set(21))
double.get() // 42
```

`computed` 是惰性的，依赖动态追踪。`batch` 合并回调内的全部通知。三者都拒绝异步回调——同步追踪和批次边界不能跨越 `await`，与其产生静默的错误结果，不如立刻抛错。

### observe：把值的变化编译成资源的重建

```ts
observe(source, owner, (value, lifetime) => {
  const socket = new WebSocket(value)
  lifetime.cleanup(() => socket.close())
})
```

每次 `source` 变化：先释放上一个 `lifetime`，再用新值建一个新的。

`observe()` 与 `@dougongjs/core` **互不依赖**——它是一个作用在结构化 `ObservationOwner`（提供 `cleanup` / `lifetime` / `spawn`）上的自由函数，所以能驱动 Core 的 Lifetime，而 Core 不需要知道它存在。插件的 `ctx` 恰好满足这个形状。

`source` 只需满足结构化的 `Readable<T>`（`get()` + `subscribe()`）——Signal、Core 的 `ContributionView`、诊断视图，甚至你自己写的对象都可以。

---

## English

**Zero-dependency** reactive primitives: `signal` / `computed` / `batch` / `observe`.

```sh
npm install @dougongjs/reactive
```

```ts
import { signal, computed, batch, observe } from "@dougongjs/reactive"

const count = signal(0)
const double = computed(() => count.get() * 2)

batch(() => count.set(21))
double.get() // 42
```

`computed` is lazy with dynamic dependency tracking. `batch` coalesces every notification inside the callback. All three reject asynchronous callbacks — synchronous tracking and batch boundaries cannot survive an `await`, and throwing immediately beats producing a silently wrong result.

### observe: compiling value change into resource rebuild

```ts
observe(source, owner, (value, lifetime) => {
  const socket = new WebSocket(value)
  lifetime.cleanup(() => socket.close())
})
```

On each change to `source`: release the previous `lifetime`, then build a new one from the new value.

`observe()` and `@dougongjs/core` are **mutually independent** — it is a free function over a structural `ObservationOwner` (anything providing `cleanup` / `lifetime` / `spawn`), so it can drive Core Lifetimes without Core knowing it exists. A plugin's `ctx` happens to satisfy that shape.

`source` need only satisfy the structural `Readable<T>` (`get()` + `subscribe()`) — a signal, Core's `ContributionView`, a diagnostics view, or your own object.

---

- 文档站 / Documentation: https://tangerg.github.io/dougong/
- 仓库 / Repository: https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。需要 Node.js ≥ 22 或等价的 ES2024 宿主。
> Early development (0.0.x); no backward-compatibility promises yet. Requires Node.js ≥ 22 or an equivalent ES2024 host.

MIT
