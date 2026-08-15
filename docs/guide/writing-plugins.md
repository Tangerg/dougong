# 编写插件

这一页从最简插件开始，逐步加上依赖、提供、配置校验、可选依赖和失败处理。

## 最简形态

```ts
import { definePlugin } from "dougong"

const plugin = definePlugin({
  name: "app.hello",
  setup() {
    console.log("started")
  },
})
```

`name` 是必填的稳定标识。它用于诊断和 Installation ID（`app.hello:1`），不参与依赖解析——依赖解析看的是 Contract。

`definePlugin` 是恒等函数，它存在的唯一目的是**推导类型**。它会在定义时校验 `name`、`requires`、`provides` 的形状，把错误留在定义处而不是启动时。

## 声明依赖

```ts
const DATABASE = service<Database>("app/database")
const ROUTES = extensionPoint<Route>("http/routes")

definePlugin({
  name: "app.users",
  requires: {
    db: DATABASE,      // Service → ctx.db 是 Database
    routes: ROUTES,    // ExtensionPoint → ctx.routes 是 ContributionView<Route>
  },
  setup(ctx) {
    ctx.db.query("select 1")
    ctx.routes.get()
  },
})
```

`requires` 的 key 是**你自己起的别名**，Contract ID 不必和它一致。这让同一个插件可以要求两个同类型的不同 Service：

```ts
requires: {
  primary: PRIMARY_DB,
  replica: REPLICA_DB,
}
```

一个 Plugin 中，一个 Contract ID 只能出现一次。若两个 alias 指向同一个 Contract，或同一个 Service 同时出现在 `requires` 和 `provides`，`definePlugin()` 会立即拒绝；请删除重复 alias，或为语义上不同的能力声明不同的 Contract ID。

::: tip 保留字
`ctx` 上有一组内置成员，别名不能和它们重名：`signal`、`meta`、`log`、`cleanup`、`lifetime`、`spawn`、`on`、`emit`、`contribute`。用了会在 `definePlugin` 时立刻报错。
:::

### 可选依赖

```ts
import { optional } from "dougong"

definePlugin({
  name: "app.telemetry",
  requires: { tracer: optional(TRACER) },
  setup(ctx) {
    ctx.tracer?.startSpan("boot")   // 类型是 Tracer | undefined
  },
})
```

没有提供者时 `ctx.tracer` 是 `undefined`，Installation 仍可正常激活。提供者后来出现或消失时，它的 Instance 会被**重建**——所以 `ctx.tracer` 在一次 Instance 生命周期内不会变。

`optional()` 只接受 Service。ExtensionPoint 不需要它：空 Map 本身就是合法值。

## 提供能力

```ts
const USERS = service<UserService>("app/users")

definePlugin({
  name: "app.users",
  requires: { db: DATABASE },
  provides: { users: USERS },
  setup(ctx) {
    return {
      users: createUserService(ctx.db),   // key 必须和 provides 一致
    }
  },
})
```

`provides` 的每个 key 都必须出现在返回值里，少一个就是 `SERVICE_NOT_RETURNED`。这条是**编译期**就能发现的：

```ts
provides: { users: USERS },
setup() {},        // ❌ Type '() => void' is not assignable to
                   //    '(context, config) => Awaitable<ProvidedServices<...>>'
```

同一个 Contract 被两个 Plugin 的 `provides` 声明占用，会在构图时抛 `SERVICE_CONFLICT`——在任何 Instance 启动之前。

## 贡献到 ExtensionPoint

```ts
definePlugin({
  name: "app.user-routes",
  setup(ctx) {
    ctx.contribute(ROUTES, "users.list", { path: "/users", run: listUsers })
    ctx.contribute(ROUTES, "users.show", { path: "/users/:id", run: showUser })
  },
})
```

第二个参数是**局部 key**，只需要在当前 Instance 内唯一。Core 会组合成真实 key：

```text
<转义后的 Installation ID>/<转义后的局部 key>
```

其中 `%` 和 `/` 分别转义为 `%25` 和 `%2F`。所以不同 Installation 可复用相同局部 key，而且两组不同的「Installation ID + 局部 key」不可能产生同一个真实 key。

返回的 `Contribution` 可以更新和提前撤回：

```ts
const c = ctx.contribute(ROUTES, "users.list", route)
c.update(nextRoute)   // 原地更新，通知订阅者
c.dispose()           // 提前撤回
```

不调用 `dispose()` 也没关系——Instance 停止时全部贡献自动撤回。

## 配置与校验

`config` 接受任何 [Standard Schema](https://github.com/standard-schema/standard-schema) 实现（Zod、Valibot、ArkType 等）：

```ts
import { z } from "zod"

const schema = z.object({
  hostname: z.string(),
  port: z.number().default(5432),
})

const db = definePlugin({
  name: "app.db",
  config: schema,
  provides: { db: DATABASE },
  setup(ctx, config) {
    //             ^ 类型是 schema 的 **输出** 类型，port 一定存在
    return { db: connect(config.hostname, config.port) }
  },
})

host.install(db, { hostname: "localhost" })   // 输入类型，port 可省略
```

注意输入和输出是两个类型：`host.install()` 接受**输入**（`port` 可选），`setup` 收到**输出**（`port` 已填默认值）。

校验失败抛 `ConfigValidationError`（code `CONFIG_INVALID`），它带一个 `issues` 数组：

```ts
try {
  await installation.ready()
} catch (e) {
  if (e instanceof ConfigValidationError) {
    e.issues.forEach((i) => console.error(i.path, i.message))
  }
}
```

**所有受影响 Installation 的 Plugin 配置会在停止任何活动 Instance 之前全部校验完毕。** 一个配置错误不会让你的应用停在半路。

## 异步 setup

```ts
definePlugin({
  name: "app.db",
  provides: { db: DATABASE },
  async setup(ctx) {
    const client = await connect()
    ctx.cleanup(() => client.close())
    return { db: client }
  },
})
```

同一拓扑层的 Installation **并发**执行 setup。启动期间 `ctx.signal` 会在同层任何 setup 失败时 abort，可以用它取消慢操作：

```ts
async setup(ctx) {
  const client = await connect({ signal: ctx.signal })
  ...
}
```

## 失败会发生什么

setup 抛异常时：

1. 该 Instance 已经获取的资源**全部尝试释放**（cleanup 逆序执行）
2. 它暂存的监听、贡献、Contract kind **一个都不发布**
3. 同一层其他 Instance 的 `ctx.signal` 被 abort
4. 整笔变更**回滚**到变更前的执行图
5. `installation.ready()` reject，`installation.status` 变成 `"failed"`
6. `host.status` 回到变更前的状态，**不会**停在中间态

```ts
const installation = host.install(brokenPlugin)
await expect(installation.ready()).rejects.toThrow("setup failed")
expect(host.status).toBe("active")     // 其他 Installation 不受影响
```

抛出非 `Error` 的值（`throw "boom"`）会被分类为 `INSTALLATION_UNAVAILABLE` 的 `DougongError`，原值保留在 `cause` 里——`undefined` 永远不会同时表示「失败值」和「没有失败」。

## 更新与移除

```ts
const installation = host.install(plugin, { hostname: "a" })

await installation.update({ config: { hostname: "b" } })   // 换配置
await installation.update({ plugin: nextVersion })     // 换声明，保持 Installation 身份
await installation.remove()
```

更新保持 **Installation 身份**：ID、诊断位置和 Group 归属不变。活动 Instance 会被替换，且只有受影响的依赖闭包会重启；无关 Installation 不动。

```ts
installation.id        // "app.db:1"
installation.status    // "pending" | "active" | "stopping" | "failed" | "removed"
installation.groupId   // 所属 Group 的 ID
await installation.ready()   // 等待这次安装就绪；失败则 reject
```

## 一个完整的例子

```ts
import { createHost, definePlugin, extensionPoint, optional, service } from "dougong"
import { z } from "zod"

const DATABASE = service<Database>("app/database")
const METRICS = service<Metrics>("app/metrics")
const ROUTES = extensionPoint<Route>("http/routes")

const database = definePlugin({
  name: "app.database",
  config: z.object({ url: z.string(), poolSize: z.number().default(10) }),
  provides: { db: DATABASE },
  async setup(ctx, config) {
    const client = await createPool(config.url, config.poolSize)
    ctx.cleanup(() => client.end())
    ctx.log.info("database connected")
    return { db: client }
  },
})

const users = definePlugin({
  name: "app.users",
  requires: { db: DATABASE, metrics: optional(METRICS) },
  setup(ctx) {
    ctx.contribute(ROUTES, "list", {
      path: "/users",
      run: async () => {
        ctx.metrics?.count("users.list")
        return ctx.db.query("select * from users")
      },
    })
  },
})

const host = createHost({ name: "api" })
host.install(users)
host.install(database, { url: process.env.DATABASE_URL! })
await host.start()
```

## 接下来

- [生命周期与资源](./lifetime.md) —— `cleanup` / `spawn` / `lifetime` 的完整规则
- [事务与变更](./transactions.md) —— 一次原子地改多个插件
- [Core API 规范](../reference/core-api.md) —— 每个 API 的边界情形
