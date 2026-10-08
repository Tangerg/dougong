# 生命周期与资源

`setup` 会打开数据库连接、注册监听器、启动轮询任务、订阅集合变化。这些资源必须在 Instance 停止时释放干净——**一次都不能漏，也不能重复释放**。

Dougong 用一个概念解决全部情况：**Lifetime**。

## 一条规则

> `setup` 从 `ctx` 拿到的一切都归当前 Instance 的根 Lifetime 所有，Instance 停止时逆序释放。

你不需要收集资源、不需要写 `dispose` 数组、不需要担心异常路径漏掉某一项。

```ts
setup(ctx) {
  const client = createClient()
  ctx.cleanup(() => client.close())      // 注册清理
  ctx.on(TICK, handler)                  // 监听器 —— 自动归属
  ctx.contribute(ROUTES, "a", route)     // 贡献 —— 自动归属
  ctx.spawn(async (signal) => poll(signal))  // 任务 —— 自动归属
}
// Instance 停止时：任务被 abort 并等待、监听器注销、贡献撤回、client.close() 执行
```

## 七种资源，同一套规则

| 资源 | 怎么产生 | 释放时发生什么 |
| --- | --- | --- |
| `cleanups` | `ctx.cleanup(fn)` | 逆序执行 `fn` |
| `tasks` | `ctx.spawn(fn)` | abort signal，等待任务结束 |
| `listeners` | `ctx.on(EVENT, fn)` | 从 EventHub 注销 |
| `contributions` | `ctx.contribute(EXT, key, v)` | 从贡献集合撤回 |
| `contributionViews` | `requires` 里的 ExtensionPoint | 视图关闭，再读抛错 |
| `subscriptions` | `view.subscribe(fn)` | 从 Store 摘除监听 |
| `children` | `ctx.lifetime(label)` | 递归释放整棵子树 |

它们共享三条性质：

1. **逆序释放** —— 后获取的先释放，和获取顺序对称
2. **全部尝试** —— 某一项释放失败不会中断其余项，错误被聚合成 `AggregateError`
3. **终态摘除** —— 提前释放的资源会从父级集合中移除，父级只拥有仍然存活的东西

第 3 条的实际意义：一个长期运行的插件反复创建又释放子资源，不会按历史次数累积终态对象。

## 提前释放

每个可释放资源都使用同一个 `dispose()` 操作；同步资源实现 `Disposable`，需要等待的资源实现 `AsyncDisposable`：

```ts
const subscription = ctx.on(TICK, handler)
subscription.dispose()          // 提前注销，不影响插件其余部分

const contribution = ctx.contribute(ROUTES, "a", route)
contribution.dispose()          // 提前撤回

const cleanup = ctx.cleanup(fn)
await cleanup.dispose()         // 提前执行 fn（只会执行一次）
```

`dispose()` 是**幂等**的：重复调用不会重复执行清理，也不会抛错。Instance 停止时不会再执行一遍已经释放的项。

同时支持 `using` / `await using` 语法（需要 `ESNext.Disposable`）：

```ts
async function listenDuring(session) {
  using subscription = session.on(TICK, handler)
  await session.emit(TICK)
  // 函数结束时自动 dispose
}

async function run(ctx) {
  await using session = ctx.lifetime("session")
  // 块结束时等待 session 完整释放
}
```

## 后台任务

```ts
const task = ctx.spawn(async (signal) => {
  while (!signal.aborted) {
    await poll()
    await delay(1000, { signal })
  }
  return "done"
})

task.result      // Promise<string>
await task.dispose() // abort 并等待结束
```

`spawn` 传给回调一个 `AbortSignal`。释放 Lifetime 时：

- **仍在运行**的任务会被 abort，Lifetime 等待它们结束
- **已经结束**的任务不会被 abort，也不会被等待——它们早已从父集合摘除

这个区分很重要：一个跑了十万次的轮询插件，不会在停止时去 abort 十万个已完成的任务。

任务抛出的异常不会静默消失，会通过 Host 的错误上报通道（`createHost({ onError })` 或 logger）报出来。取消只覆盖 `signal.reason` 或明确的 `AbortError`；任务在收到取消后又发生的其他错误仍会报告。

::: warning abort 不是抢占
`task.dispose()`、Lifetime 释放与 `host.stop()` 都会在发出 abort 后等待任务体真正 settle。`AbortSignal` 只是取消通知：若任务正 `await` 一个不接受 signal、也不返回的操作，停止也会一直等待。Dougong 不会静默遗弃仍归 Lifetime 所有的工作。
:::

优先把 signal 传给真正支持取消的适配器。如果第三方操作确实不可取消，而且它在停止后的完成与失败都可以安全忽略，可以在应用代码中明确采用“放弃等待”策略：

<<< ../../packages/examples/src/abandon-on-abort.ts

```ts
ctx.spawn((signal) =>
  abandonOnAbort(signal, () => legacyClient.flush()),
)
```

这份代码直接引用受测示例源码。预取消时不会注册监听器，也不会调用 `start`；取消、成功和失败都会解除监听。取消检查和 `start()` 在同一个回调中执行，不留出检查通过后再取消、却仍启动操作的 microtask 间隙。

这个 helper 只让 Dougong 的 Task 放弃**等待**，不会终止底层操作；拒绝处理器仍会观察它以后发生的失败，避免产生无关的 unhandled rejection。它适用于迟到值与失败都可以安全忽略、且没有资源需要释放的操作。资源获取需要下面的[晚到资源交接范式](#retired-acquisition)；停止后仍可能改写已释放状态的操作需要真正可取消的适配器。

## 子生命周期

当一组资源需要作为整体被替换或释放时，用子 Lifetime：

```ts
async setup(ctx) {
  let current: LifetimeContext | undefined

  const connect = async (url: string) => {
    await current?.dispose()                  // 完整释放上一组
    const scope = ctx.lifetime(`conn:${url}`) // label 用于诊断
    const socket = openSocket(url)
    scope.cleanup(() => socket.close())
    scope.spawn((signal) => readLoop(socket, signal))
    current = scope
  }

  await connect(initialUrl)
}
```

`label` 是必填的非空字符串，只用于诊断，不参与任何查找或身份判定，同级重名合法。

子 Lifetime 提前 `dispose()` 后会从父级摘除；父级释放时会递归释放所有存活的子树。已经归父级所有的子级不需要再注册 cleanup 来释放。

## 等待退役与晚到资源交接 {#retired-acquisition}

有些外部操作不能取消，却会返回必须关闭的资源，例如异步打开 stream。视图更换时，旧 generation 需要退出等待，操作晚到的结果仍需要有人释放。这时不能直接忽略 `abandonOnAbort` 遗弃的值。

下面是受测的应用组合范式，只使用公开 Lifetime API，不是新增的 Core 或 facade API。应用明确提供两个不同的 owner：

- `generation` 拥有这次等待，以及及时取得的资源。取消后不再接收结果；成功交付前先同步注册 `generation.cleanup()`。
- `operations` 拥有真实的底层操作、晚到资源处置，以及它们的错误上报。它必须是比 generation 更长寿的祖先或独立 Lifetime，不能是 generation 本身或其后代。

`operations` 必须保持 active，直到实际建立底层 Task。若它已经开始释放，`spawn()` 会在创建 Task 前同步抛出 `LIFETIME_DISPOSED`；等待尚未取消时，该错误使调用方的 Promise 拒绝，由调用方处理，而不会返回 `failed` 投影。

源码直接来自示例包，和回归测试使用同一份实现：

<<< ../../packages/examples/src/retired-acquisition.ts

底层 Task 的结果使用以下只读投影：

| 结果 | 调用方应如何处理 |
| --- | --- |
| `acquired` | 资源已经归 generation 所有，可以在仍有使用资格时消费 |
| `failed` | 操作错误已进入 `operations` 所属 Host 的上报通道；可显示失败状态，不要再次抛出或重复上报 `error` |
| `retired` | 底层任务不再交付资源，必要的晚到处置已完成 |

generation 取消时，对调用方的 Promise 仍以 `generation.signal.reason` 拒绝，让所属 Task 按既有取消规则结束；调用方不需要等待底层任务返回 `retired`。外部操作或晚到处置的失败包装为 `Error("External resource operation failed", { cause })`，原始错误保留在 `cause`。这样即使适配器抛出的错误叫 `AbortError`，也不会在最终停止 `operations` 时被误当成该 Task 的协作取消而漏报。`failed.error` 是已经上报的这个错误。

如果底层 Task 已创建，但在任务体开始前被取消，它不会调用 `start()`；仍然活动的 generation 会收到 `retired`。操作一旦开始，`operations` 继续等待它和必要的晚到处置结束。

例如，把底层操作和可替换视图放在同一应用 Lifetime 的不同子树中：

```ts
const operations = ctx.lifetime("external-operations")
const generation = ctx.lifetime("view:1")

generation.spawn(async (signal) => {
  const result = await acquireForLifetime(
    generation,
    operations,
    () => legacyClient.openStream(),
    (stream) => stream.close(),
  )
  signal.throwIfAborted()
  if (result.status !== "acquired") return
  await consumeStream(result.value, signal)
})
```

应用替换视图时，只释放当前 generation，然后建立后任：

```ts
await generation.dispose()
const nextGeneration = ctx.lifetime("view:2")
```

旧操作即使尚未完成，也不会阻塞这个切换。若它晚到成功，资源直接在 `operations` 的 Task 内关闭，不交给后任 generation；操作失败与晚到 disposer 失败也由该 Task 通过既有 Host 通道上报。已经正常交付的资源继续由 `generation.cleanup()` 释放，其失败遵循普通 Lifetime cleanup 的聚合规则。不要等旧 generation 已释放后，再向它注册晚到 cleanup 或让它承担错误上报。

::: warning 等待退役没有改变最终 join
`operations` 仍然完整拥有底层工作。如果操作永不 settle，`operations.dispose()` 和最终的 `host.stop()` 仍会保持 pending；晚到 disposer 不结束也会如此。这个范式只允许短寿命 generation 先退出，并不承诺应用可以跳过最终收尾。普通 `ctx.spawn()`、Task、Lifetime 和 Host 的 abort + join 契约保持不变。
:::

退役边界是 generation 的 signal。单独对等待者调用 `task.dispose()` 不会取消仍然活动的 generation，这种情况下该 Task 仍会等待获取完成或 generation 退役。

这里没有取消远端执行，也不会重发任何命令。远端服务是否已接受命令、能否重试、哪个 generation 可以提交 UI，以及同一领域 identity 内的串行顺序与不同 identity 之间的并发，都由应用决定。取得资源不自动授予 UI 提交资格；应用仍须在提交边界检查自己的当前身份。

## 三个阶段

Lifetime 有三个阶段：`active` → `disposing` → `disposed`。

调用 `dispose()` 会同步封住整棵所有权子树，全部 Context 操作随之关闭，包括 `emit()`。Dougong 先撤销所有后代的监听、订阅与 View，再撤回贡献，然后取消 signal；入口全部关闭后，任务与各后代 Lifetime 并行收尾，子级按创建逆序开始关闭；每个 Lifetime 都在自身任务与子级结束后执行 cleanup。父任务收尾缓慢也不会使子级继续接收事件。cleanup 只负责释放资源。

`emit()` 在这个边界返回以 `LIFETIME_DISPOSED` 拒绝的 Promise，不会同步抛出。因此有意忽略终止竞态时可以明确写 `void ctx.emit(STOPPED).catch(report)`；若某个“已停止”状态必须始终可读，应把它放在 Service/Signal，而不是 cleanup Event。

## 观察所有权树

诊断里有一份实时的 Lifetime 所有权树：

```ts
const snapshot = host.diagnostics.get()
const lifetime = snapshot.installations.get(installationId)?.lifetime

lifetime.get()
// {
//   label: "app.users:1",
//   phase: "active",
//   cleanups: 1, tasks: 1, listeners: 2,
//   contributions: 3, contributionViews: 1, subscriptions: 1,
//   children: [
//     { label: "conn:wss://a", phase: "active", tasks: 1, ... }
//   ]
// }

lifetime.subscribe(() => render())   // 资源变化时通知
```

这份快照是**递归冻结的纯数据**——只有标签、阶段和计数，不暴露 Lifetime 对象、资源、回调或 Store。节点计数只描述该 Lifetime **直接**拥有的资源，子树合计由 `children` 递归推导，快照里不保存第二份聚合状态。

它和 Host 快照是两个独立的订阅源：高频的资源变化不会重建整张 Host 快照。

## 不会反向保活

这是一条容易被忽略但影响很大的性质：

> 保留一个已释放的资源，不会保活 Host、Store、回调或 payload。

具体做法：

- 终态资源清空自己对 owner、Store、回调和 payload 的引用
- 终态 Installation 只保留不可变身份数据，不持有 GroupNode
- 已分离的 Group 清空 parent 引用，历史 Group 不能经所有权树保活兄弟子树
- 终态失败保留冻结、有界的 `RecordedFailure` 记录，含栈文本和纯值 cause，不保留原始 Error 对象及其应用载荷
- 历史诊断视图在关闭时切断上报回调

仍附着于活动 Host、可恢复的失败 Installation 保留原始 Error，供 `ready()` 和重试使用；诊断始终暴露 `RecordedFailure`。被丢弃的 Installation 释放权限并只保存该记录，后续 `ready()` 拒绝为 `RecordedFailure`，不重建原异常类。精确边界见[错误记录契约](../reference/errors.md#诊断失败记录)。

## 常见错误

**在 setup 外面获取资源**

```ts
setup(ctx) {
  setTimeout(() => {
    ctx.cleanup(() => {})   // ❌ 插件可能已经停止 → 抛错
  }, 1000)
}
```

要在延迟逻辑里获取资源，用 `ctx.spawn()`，它的 signal 会在释放时 abort。

**手工收集句柄**

```ts
setup(ctx) {
  const disposables = []                      // ❌ 不需要
  disposables.push(ctx.on(A, f))
  ctx.cleanup(() => disposables.forEach(d => d.dispose()))
}
```

`ctx.on()` 已经归 Lifetime 所有了，再包一层只会让释放执行两次（幂等，所以不会出错，但纯属多余）。

## 接下来

- [事务与变更](./transactions.md) —— 多 Installation 原子变更与回滚
- [响应式与观察](./reactive.md) —— `observe()` 如何在 Lifetime 上组合
- [Core API 规范](../reference/core-api.md#九lifetime-与-disposable) —— 精确语义与边界情形
