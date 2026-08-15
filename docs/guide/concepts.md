# 核心概念

Dougong 的模型由六个原子组成。它们**正交**——每个解决一件事，不能互相替代。这一页解释每个原子回答的问题，以及最容易搞混的几组区别。

## 全景

| 原子 | 一句话 | 回答的问题 |
| --- | --- | --- |
| **Contract** | 冻结的身份令牌 | 「这个能力叫什么，是什么类型」 |
| **Service** | 稳定的一对一能力 | 「谁提供数据库连接」 |
| **ExtensionPoint** | 开放的贡献集合 | 「有哪些路由 / 命令 / 主题」 |
| **Event** | 瞬时事实 | 「刚才发生了什么」 |
| **Lifetime** | 结构化所有权 | 「谁拥有这个资源，什么时候释放」 |
| **Plugin** | 一次 setup 产生一组能力 | 「这个功能单元是什么」 |
| **Host** | 依赖图 + 事务 + 编排 | 「这些单元怎么组成一个运行时」 |

## Contract：身份先于实现

Contract 是一个冻结的 `{ id, kind }` 对象，把**字符串 ID** 和 **TypeScript 类型**绑在一起：

```ts
import { service, extension, event } from "dougong"

const DATABASE = service<Database>("app/database")
const ROUTES = extensionPoint<Route>("http/routes")
const USER_CREATED = event<User>("users/created")
```

三种 kind 对应三种能力语义。同一个 ID 在一个 Host 里**不能同时承担两种 kind**，否则抛 `CONTRACT_CONFLICT`。

Contract 不持有运行时状态，可以跨 Host 复用，应该从稳定模块导出**一次**：

```ts
// contracts.ts —— 提供方和消费方都从这里 import
export const DATABASE = service<Database>("app/database")
```

::: warning 一个 TypeScript 管不到的地方
两个模块可以为同一个 ID 写出不同的类型参数：

```ts
// a.ts
export const FOO = service<Logger>("app/foo")
// b.ts
export const FOO = service<Database>("app/foo")   // 同 ID、同 kind、不同类型
```

TypeScript 无法阻止这件事，运行时也不会报错——消费者会静默拿到错误类型的实现。**固定 Contract 的同一 ID 应在代码库中只声明一次并从稳定模块导出。**
:::

## Service vs ExtensionPoint：一对一 vs 多对多

这是最常见的选择题。判据只有一条：**这个能力有一个提供者，还是任意多个？**

```ts
// Service：整个 Host 里只能有一个提供者
const DATABASE = service<Database>("app/database")
// 两个插件都声明 provides: { db: DATABASE } → SERVICE_CONFLICT

// ExtensionPoint：任意多个插件可以往里贡献，也可以运行期增删
const ROUTES = extensionPoint<Route>("http/routes")
```

用法上的区别：

```ts
// Service —— 提供方从 setup 返回
definePlugin({
  name: "app.db",
  provides: { db: DATABASE },
  setup: () => ({ db: createClient() }),      // 不返回 → SERVICE_NOT_RETURNED
})

// Service —— 消费方直接拿到实现
definePlugin({
  requires: { db: DATABASE },
  setup: (ctx) => { ctx.db.query("...") },     // ctx.db 就是 Database
})

// ExtensionPoint —— 贡献方用 contribute，拿到一个可更新可释放的 Handle
definePlugin({
  setup(ctx) {
    const c = ctx.contribute(ROUTES, "users.list", { path: "/users", run })
    c.update({ path: "/users", run: newRun })  // 原地更新
    c.dispose()                                // 提前撤回
  },
})

// ExtensionPoint —— 消费方拿到的是一个实时视图，不是快照
definePlugin({
  requires: { routes: ROUTES },
  setup(ctx) {
    ctx.routes.get()                            // ReadonlyMap<string, Route>
    ctx.routes.subscribe(() => rebuildRouter()) // 集合变化时通知
  },
})
```

关键差异：

| | Service | ExtensionPoint |
| --- | --- | --- |
| 提供者数量 | 恰好 1 | 0..n |
| 消费方拿到 | 实例期**不变**的实现 | **实时**视图 `get()` / `subscribe()` |
| 提供者变化时 | 消费者被**重建** | 消费者收到通知，不重建 |
| 缺失时 | `SERVICE_MISSING`（除非用 `optional()`） | 空 Map 是合法值 |

最后一行解释了为什么 `optional()` 只接受 Service：ExtensionPoint 的空集合本身就是有效状态，不需要「可选」这个概念。

### 为什么 Service 快照不变

消费者拿到的 `ctx.db` 在整个实例期内是**同一个对象**，不是 live proxy。如果提供者被更新或移除，Dougong 会**重建消费者**（停止再启动），而不是悄悄替换它手里的引用。

这样插件里可以放心地写：

```ts
setup(ctx) {
  const db = ctx.db                     // 存起来
  ctx.spawn(async () => { db.query() }) // 后台任务里用，不用担心它变了
}
```

代价是提供者变更的影响面更大（依赖闭包内的插件都会重启），收益是插件内部不需要任何防御性重读。

## Event：已经发生的事实

Event 是**瞬时**的——不保存状态，没有「提供者」的概念，晚订阅的人拿不到历史。

```ts
definePlugin({
  setup(ctx) {
    ctx.on(USER_CREATED, (user) => sendWelcomeMail(user))  // 监听
  },
})

definePlugin({
  setup(ctx) {
    await ctx.emit(USER_CREATED, user)   // 发送，等待所有监听器完成
  },
})
```

`emit()` 返回 Promise 并等待所有监听器。只有一种分发方式——没有 `parallel` / `serial` / `bail` / `waterfall` 的选择题。需要收集返回值？那不是 Event 的语义，用 ExtensionPoint。

### 三者怎么选

问自己：**消费方需要的是「现在的状态」还是「刚才的变化」？**

- 需要状态，且只有一个来源 → **Service**
- 需要状态，来源开放 → **ExtensionPoint**
- 需要知道变化发生过，不需要保存 → **Event**

一个常见错误是用 Event 传递状态：

```ts
ctx.emit(CONFIG_CHANGED, newConfig)   // ❌ 晚安装的插件永远收不到当前配置
```

配置是状态，应该是 Service 或 ExtensionPoint。

## Lifetime：谁拥有什么

每个插件实例有一个根 Lifetime。插件在 `setup` 里获取的一切资源都归它所有，插件停止时**自动逆序释放**。

```ts
setup(ctx) {
  ctx.cleanup(() => client.close())          // 注册清理
  const task = ctx.spawn(async (signal) => { // 后台任务，signal 在释放时 abort
    await poll(signal)
  })
  const child = ctx.lifetime("connection")   // 子生命周期，可整体释放
  child.cleanup(() => socket.close())
  await child.dispose()                      // 提前释放子树
}
```

`ctx.on()` 和 `ctx.contribute()` 返回的 Handle 也归 Lifetime 所有——你不需要手工收集它们。

七种资源（cleanups、tasks、listeners、contributions、extensionViews、subscriptions、childLifetimes）走**同一套所有权规则**：提前释放会从父级摘除，父级释放会逆序清理所有存活资源并聚合错误。

详见[生命周期与资源](./lifetime.md)。

## Plugin：一次 setup 产生一组能力

```ts
const plugin = definePlugin({
  name: "app.users",                    // 稳定名字
  config: UserConfigSchema,             // 可选：Standard Schema 校验
  requires: { db: DATABASE },           // 依赖
  provides: { users: USER_SERVICE },    // 提供
  setup(ctx, config) {                  // 一次调用产生全部能力
    return { users: createUserService(ctx.db, config) }
  },
})
```

`setup` 可以是异步的。它的返回值必须包含 `provides` 里声明的每一个 key，否则 `SERVICE_NOT_RETURNED`。

**插件是定义，安装是实例。** 同一个定义可以安装多次（配置不同），每个安装有独立的 ID 和 Lifetime。

## Host：把这些组织起来

```ts
const host = createHost({ name: "my-app" })

const handle = host.install(plugin, config)  // 返回 Handle
await host.start()                           // 构图、拓扑排序、分层并发启动
host.status                                  // "idle" | "starting" | "active" | "changing" | "stopping"
host.get(SOME_SERVICE)                       // 应用代码读取（仅 active 时）
host.diagnostics.get()                       // 不可变运行状态快照
await host.stop()                            // 逆序停止
```

Host 负责四件事：

1. **依赖图** —— 从 `requires` / `provides` 推导，检测环（`SERVICE_CYCLE`，报真实环路径）和重复提供者（`SERVICE_CONFLICT`）
2. **事务** —— 变更要么整体生效，要么回滚到变更前，见[事务与变更](./transactions.md)
3. **实例编排** —— 分层并发启动、逆序停止、增量重启受影响闭包
4. **诊断** —— 一份不可变、可订阅的运行状态读模型

## Signal 为什么不在这个列表里

`@dougongjs/reactive` 提供 `signal()` / `computed()` / `batch()` / `observe()`，但 **Signal 不是第五种插件能力**。

理由：Signal 是**值的表示方式**，不是**能力的组织方式**。一个 Service 可以返回 Signal，一个 ExtensionPoint 的值可以是 Signal——但把 Signal 做成第五种 Contract kind 会让「这个能力是 Service 还是 Signal」变成一个没有正确答案的问题。

Core 不依赖 reactive，也不提供隐式 effect。详见[响应式与观察](./reactive.md)。

## Group 不是作用域

`host.group(name, configure)` 建立**安装所有权树**——用来批量安装、批量移除、批量等待就绪。

```ts
const feature = host.group("feature", (plugins) => {
  plugins.install(a)
  plugins.install(b)
})
await feature.ready()
await feature.remove()   // 整棵子树一起移除
```

Group **不改变**任何可见性：Service 解析、ExtensionPoint 和 Event 的可见范围始终是**整个 Host**。它不是能力作用域、不是 provider 影子树、不是权限边界、也不是安全沙箱。

需要同型多实例？用显式 Contract family。需要运行期租户选择？用普通方法参数。需要安全隔离？用 Host、Worker、iframe 或进程——真正的隔离边界。

## 接下来

- [编写插件](./writing-plugins.md) —— 配置校验、可选依赖、失败与更新
- [生命周期与资源](./lifetime.md) —— 所有权规则的完整形态
- [Core API 规范](../reference/core-api.md) —— 每个 API 的边界情形
