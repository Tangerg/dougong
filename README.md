# Dougong

[文档站](https://tangerg.github.io/dougong/) · [API 设计](docs/api-design.zh-CN.md) · [整体架构](docs/architecture.zh-CN.md) · [可执行示例](packages/examples/README.md)

Dougong（斗拱）是一个面向 JavaScript/TypeScript 的**能力组合与结构化生命周期内核**，以及建立在它之上的插件分发层。

它只用普通对象、普通函数、Promise、AbortSignal 和 Disposable，解决六件事：

- `Service`：稳定的一对一能力；
- `Extension`：可动态增减的开放贡献集合；
- `Event`：不保留状态的瞬时事实；
- `Lifetime`：监听、贡献、任务和资源的所有权；
- `Plugin`：一次 setup 产生一组能力；
- `Application`：依赖图、事务与实例编排。

Signal 不是第五种插件能力。`@dougong/reactive` 提供 `signal()`、`computed()`、`batch()` 和基于公开 Lifetime API 的 `observe()`；Core 不依赖它，也不提供隐式 effect。

## 单路径原则

同一层、同一种语义只有一个正式入口。高层语法糖必须机械展开到这个入口，不能拥有第二套状态机：

| 语义 | 正式入口 |
| --- | --- |
| 安装插件 | `install()` |
| 原子修改安装计划 | `change()` |
| 发布 Service | `provides` + `setup()` 返回值 |
| 贡献 Extension | `contribute()` |
| 监听 / 发送 Event | `on()` / `emit()` |
| 注册资源 | `cleanup()` |
| 创建子生命周期 / 任务 | `lifetime()` / `spawn()` |
| 读取 / 订阅实时值 | `get()` / `subscribe()` |
| 更新 / 删除安装 | `update()` / `remove()` |
| 提前释放资源 | `dispose()` |

同时遵守**显式优于隐式**：Service 选择写进 Contract ID，依赖写进 `requires`，资源归属写进 Lifetime，运行期租户选择写进普通方法参数。Core 不从 Group、调用栈、祖先 Context 或全局“当前 workspace”猜测关系。

## Workspace

```text
packages/
  core/       六个内核原子、依赖图、事务、Group 与诊断
  reactive/   独立的 Signal 值层与 Lifetime 组合器
  platform/   Manifest、Loader、权限、懒激活与 HMR
  dougong/    纯 re-export 的便利入口
  examples/   从基础原子到 Planet / Lynx、声明式计划与模块图 HMR 的可执行示例
```

`core` 与 `reactive` 是互不依赖的基础层；`platform` 只依赖 `core`；`dougong` 只是组合入口。

## Example

```ts
import { createApp, definePlugin, extension, service } from "dougong"

const DATABASE = service<Database>("app/database")
const ROUTES = extension<Route>("http/routes")

const database = definePlugin({
  name: "app.database",
  provides: { database: DATABASE },
  setup(ctx) {
    const client = createDatabaseClient()
    ctx.cleanup(() => client.close())
    return { database: client }
  },
})

const users = definePlugin({
  name: "app.users",
  requires: { database: DATABASE },
  setup(ctx) {
    ctx.contribute(ROUTES, "users.list", {
      path: "/users",
      run: () => ctx.database.query("select * from users"),
    })
  },
})

const app = createApp({ name: "example" })
app.install(users)
app.install(database)

await app.start()
```

安装顺序不必等于启动顺序；Dougong 从 Service 声明推导依赖图，同一拓扑层并发 prepare、整层成功后统一发布，并按逆依赖顺序停止。

## Guarantees

- 插件拿到的是整个实例期不变的 Service 快照；提供者变化会重建消费者，不使用 live Proxy。
- Extension 只保存原始贡献。排序、领域 key、覆盖和 pipeline 是公开 API 上的高层组合策略，不进入 Core。
- setup 期间的监听与贡献先暂存；输出校验通过后才与 Service 一起发布。
- 多插件变更只走一份 ChangeSet；失败时恢复旧图，无法可靠恢复时 fail closed。
- Group 只负责组合、批量提交和子树所有权，不改变 Service、Extension 或 Event 的可见性。
- 同型多实例使用显式 Contract family；Group 不参与 Service shadow 或作用域查找。
- 插件诊断包含独立的实时 Lifetime 资源计数视图，高频资源变化不重建整张 Application 快照。
- 所有公共 Handle 都是冻结的窄对象；不会在 JavaScript 运行时泄露内部 record、registry、host 或事务发布方法。
- Core 不理解 Node、DOM、React、HTTP、文件系统、Loader 或权限。

完整规范见 [API 设计](docs/api-design.zh-CN.md)、[架构说明](docs/architecture.zh-CN.md) 与 [Platform 设计](docs/platform-design.zh-CN.md)。

从最小 Service 到 Planet / Lynx、声明式计划与模块图 HMR 的完整学习路径见 [examples package](packages/examples/README.md)，可运行 `pnpm examples`。

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` 依次执行类型检查、lint、格式检查、测试与覆盖率、未使用代码检查、循环依赖检查、架构层级检查和发布构建。
