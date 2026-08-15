# 响应式与观察

`@dougongjs/reactive` 是一个**零依赖**的值层，提供 `signal` / `computed` / `batch` 和一个组合器 `observe`。

它和 Core **互不依赖**。这一页解释这个设计决定是什么意思，以及怎么用。

## 为什么 Signal 不是第五种能力

Core 有 Service、ExtensionPoint、Event 三种 Contract kind。一个自然的问题是：为什么不加第四种 `signal<T>()`？

因为 **Signal 是值的表示方式，不是能力的组织方式**。

一个 Service 可以返回 Signal，一个 ExtensionPoint 的值可以是 Signal：

```ts
const THEME = service<{ current: ReadonlySignal<Theme> }>("app/theme")
```

如果 Signal 也是一种 Contract kind，那么「主题这个能力应该是 Service 还是 Signal」就变成一个没有正确答案的问题——两种写法都能工作，团队里会同时出现两种，而它们的依赖语义、事务语义、诊断形态全都不同。

**同一层、同一种语义只有一个正式入口。** 能力的组织入口是 Service / ExtensionPoint / Event；至于这个能力返回的值是不是响应式的，是插件自己的实现细节。

同理，Core 不提供隐式 effect。副作用的归属必须写在 Lifetime 上，不能靠「谁在读我」自动推断。

## 值层

```ts
import { signal, computed, batch } from "dougong"

const count = signal(0)
const double = computed(() => count.get() * 2)

count.get()      // 0
double.get()     // 0

count.set(21)
double.get()     // 42
```

`computed` 是**惰性**的：没有订阅者时不会主动计算，只在 `get()` 时按需求值并缓存。依赖是**动态追踪**的——每次求值重新收集，分支里没走到的 signal 不会成为依赖。

```ts
const a = signal(1), b = signal(2), useA = signal(true)
const value = computed(() => (useA.get() ? a.get() : b.get()))
// useA 为 true 时，b 的变化不会让 value 失效
```

### batch

```ts
batch(() => {
  first.set(1)
  second.set(2)
})   // 订阅者只被通知一次
```

`batch` 合并回调内的全部通知。嵌套 `batch` 只在最外层结束时 flush。

::: warning 三个入口都拒绝异步
```ts
batch(async () => { ... })            // ✗ TypeError: Reactive batches must be synchronous
computed(async () => { ... })         // ✗ TypeError: Computed signal calculations must be synchronous
observe(source, async () => { ... })  // ✗ TypeError: Observers must be synchronous
```

原因是同步追踪和批次边界不能跨越 `await`——一旦跨过去，依赖收集会收到错误的集合，批次会在异步工作完成前就 flush。与其产生静默的错误结果，不如立刻抛错。

异步工作应该放进 `lifetime.spawn()`。
:::

### 订阅

```ts
const subscription = count.subscribe(() => console.log("changed"))
subscription.dispose()
```

`Signal` 和 `ReadonlySignal` 都实现结构化的 `Readable<T>` 协议：

```ts
interface Readable<T> {
  get(): T
  subscribe(listener: () => void): Disposable
}
```

Core 的 `ContributionView` 和 `diagnostics` 用的是**同一个协议**。这意味着任何观察源都可以被同样的方式消费——不需要适配器。

## observe：把值的变化编译成资源的重建

`observe()` 是这个包里唯一和 Lifetime 打交道的东西，而它是一个**自由函数**，作用在结构化协议上：

```ts
import { observe } from "dougong"

observe(source, owner, (value, lifetime) => {
  // 每次 source 变化：先释放上一个 lifetime，再用新值建一个新的
})
```

三个参数：

- `source` —— 任何 `Readable<T>`：Signal、`ContributionView`、`diagnostics`，甚至你自己写的对象
- `owner` —— 任何提供 `cleanup` / `lifetime` / `spawn` 的东西，插件的 `ctx` 正好符合
- `observer` —— 拿到当前值和一个专属子 Lifetime

### 典型用法

```ts
const CURRENT_TRACK = service<Readable<Track | undefined>>("player/current")

definePlugin({
  name: "player.audio",
  requires: { current: CURRENT_TRACK },
  setup(ctx) {
    observe(ctx.current, ctx, (track, lifetime) => {
      if (!track) return

      const element = new Audio(track.url)
      lifetime.cleanup(() => {
        element.pause()
        element.src = ""
      })

      lifetime.spawn(async (signal) => {
        await waitForCanPlay(element, signal)
        await element.play()
      })
    })
  },
})
```

每次 `current` 变化，Dougong 会：

1. 释放上一个 `lifetime`（暂停并清理旧的 audio 元素、abort 旧任务）
2. 用新值创建一个新的子 Lifetime
3. 插件停止时，最后一个子 Lifetime 和这个观察本身一起被释放

你不需要写「先判断有没有上一个、有的话先清理」这类样板——**释放旧的、建立新的**是 `observe` 的语义本身。

### 为什么这是自由函数

`observe` 不在 Core 里，Core 也不知道它存在。它靠的是结构化类型：

```ts
interface ObservationOwner {
  cleanup(fn): Disposable
  lifetime(label): ObservationLifetime
  spawn(fn): ObservationTask
}
```

插件的 `ctx` 恰好满足这个形状，所以 `observe(source, ctx, ...)` 直接能用——但这是**结构匹配**，不是继承或注册。

结果是依赖方向保持单向：`reactive` 不依赖 `core`，`core` 也不依赖 `reactive`。你可以只用其中一个。

### 失败处理

`observe` 的错误语义是明确的：

- observer 抛异常 → 通过 owner 的任务结果上报，观察保持存活，下次变化会重试
- 释放旧子 Lifetime 失败 → 观察**永久停止**并释放订阅，因为无法确认旧资源是否真的释放了
- 变化通知在观察还在处理上一次时到达 → 合并，只用最新值重建一次

## 两个观察源，两种用法

Core 里有两个地方产出 `Readable`：

```ts
// ExtensionPoint 视图 —— 集合变化
ctx.routes.get()                    // ReadonlyMap<string, Route>
ctx.routes.subscribe(() => ...)

// 诊断 —— 运行状态
host.diagnostics.get()
host.diagnostics.subscribe(() => ...)

// 插件的 Lifetime 所有权树
snapshot.plugins.get(id)?.lifetime.get()
```

它们都能直接喂给 `observe()`：

```ts
observe(ctx.routes, ctx, (routes, lifetime) => {
  const router = buildRouter(routes)
  lifetime.cleanup(() => router.close())
})
```

路由集合每次变化就重建一次路由器，旧的自动关闭。

## 和 UI 框架的关系

Dougong 不绑定任何 UI 框架。React / Vue / Solid 各自有成熟的响应式方案，`@dougongjs/reactive` 不打算替代它们。

它存在的理由是：**Core 需要一个不依赖 UI 框架的观察协议**，用来表达「集合变了」「诊断变了」这类事实。如果你的应用是 React 应用，用 `useSyncExternalStore` 桥接即可：

```ts
const routes = useSyncExternalStore(
  (cb) => { const s = view.subscribe(cb); return () => s.dispose() },
  () => view.get(),
)
```

`get` / `subscribe` 这个协议正好是 `useSyncExternalStore` 需要的形状。

## 接下来

- [外部插件分发](./platform.md) —— Manifest、权限、懒激活、HMR
- [Core API 规范](../reference/core-api.md) —— 统一观察协议的精确定义
- [可执行示例 04](../examples.md#stage-1) —— Signal、observe 与显式资源重建的完整场景
