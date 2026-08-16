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
  await session.emit(TICK, undefined)
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
task.dispose()   // abort 并等待结束
```

`spawn` 传给回调一个 `AbortSignal`。释放 Lifetime 时：

- **仍在运行**的任务会被 abort，Lifetime 等待它们结束
- **已经结束**的任务不会被 abort，也不会被等待——它们早已从父集合摘除

这个区分很重要：一个跑了十万次的轮询插件，不会在停止时去 abort 十万个已完成的任务。

任务抛出的异常不会静默消失，会通过 Host 的错误上报通道（`createHost({ onError })` 或 logger）报出来。取消只覆盖 `signal.reason` 或明确的 `AbortError`；任务在收到取消后又发生的其他错误仍会报告。

## 子生命周期

当一组资源需要作为整体被替换或释放时，用子 Lifetime：

```ts
setup(ctx) {
  let current: LifetimeContext | undefined

  const connect = (url: string) => {
    current?.dispose()                        // 释放上一组
    const scope = ctx.lifetime(`conn:${url}`) // label 用于诊断
    const socket = openSocket(url)
    scope.cleanup(() => socket.close())
    scope.spawn((signal) => readLoop(socket, signal))
    current = scope
  }

  connect(initialUrl)
  ctx.cleanup(() => current?.dispose())
}
```

`label` 是必填的非空字符串，只用于诊断，不参与任何查找或身份判定，同级重名合法。

子 Lifetime 提前 `dispose()` 后会从父级摘除；父级释放时会递归释放所有存活的子树。

## 三个阶段

Lifetime 有三个阶段：`active` → `disposing` → `disposed`。

```ts
setup(ctx) {
  ctx.cleanup(async () => {
    await ctx.emit(SHUTTING_DOWN, undefined)   // ✓ disposing 阶段允许 emit
  })
}
```

`disposing` 阶段仍然允许 `emit`——清理逻辑经常需要广播「我要走了」。但**不允许**再获取新资源（`cleanup` / `spawn` / `on` / `contribute` / `lifetime` 都会抛错），否则会产生没人负责释放的资源。

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
- **终态失败只保留 `name` / `message` / `code` 纯数据摘要**——JavaScript 的 `Error.stack` 可能携带创建错误时的整个编排调用帧，不能成为一条隐形的所有权边
- 历史诊断视图在关闭时切断上报回调

仍附着于活动 Host 的失败 Installation 继续保留原始错误，供诊断和重试使用。等待 `ready()` 的调用方也总是收到原始 `Error`——摘要只影响 Installation **脱离 Host 之后**的事后读取。

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
