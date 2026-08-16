# Dougong Core API 规范

::: tip 这是规范层
本文是 `@dougongjs/core` 的**可观察行为规范**，按精确性而非可读性组织，用于确定边界情形和实现一致性。

第一次接触 Dougong，请先读[核心概念](../guide/concepts.md)和[编写插件](../guide/writing-plugins.md)——那两页讲的是同样的模型，但按学习顺序展开。
:::

实现与本文冲突时，应治本式修改实现或规范，不增加兼容别名。

Dougong Core 的定位是：

> 纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。

它不是 IoC 容器、响应式框架、事件框架或前端框架。它提供少量正交原子，使高级能力能够由普通函数和普通对象组合出来。

## 一、不可破坏的设计公理

### 1. 单路径

同一抽象层、同一种语义只允许一个正式入口。高层语法糖必须机械展开到该入口，不能拥有第二套状态机、事务、依赖图、资源栈或错误模型。

| 语义 | 唯一入口 | Core 不提供 |
| --- | --- | --- |
| 安装插件 | `install()` | `use` / `apply` / `load` |
| 修改安装计划 | `change()` | 第二套 transaction / batch |
| 发布 Service | `provides` + setup 返回值 | `ctx.provide` / `host.provide` |
| 贡献 ExtensionPoint | `contribute()` | `add` / `append` / `register` |
| 监听 Event | `on()` | `listen` / `hook` |
| 发送 Event | `emit()` | `dispatch` / `publish` / `fire` |
| 注册清理 | `cleanup()` | `using` / `own` / `defer` |
| 创建子生命周期 | `lifetime(label)` | `child` / `scope` / `fiber` |
| 启动后台任务 | `spawn()` | `run` / `fork` / `task` |
| 判定取消结果 | `isCancellationReason()` | 只看 `signal.aborted` / 只匹配错误名 |
| 校验声明 record | `assertPlainRecord()` | 各高层复制 prototype / own-key 校验 |
| 读取实时值 | `get()` | `.value` / 函数调用 / `getSnapshot()` |
| 订阅变化 | `subscribe()` | `watch` / `listen` / `observeChanges` |
| 更新 Installation | `update()` | `replace` / `reload` / `restart` |
| 删除安装 | `remove()` | `uninstall` / `delete` |
| 释放资源 | `dispose()` | `close` / `destroy` / `off` |

`host.install()`、`installation.update()` 和 `installation.remove()` 是单目标语法糖，内部只创建一份 one-shot ChangeSet 并提交。它们不拥有第二套校验、队列或回滚逻辑。

`assertPlainRecord(value, label, { fields, createError })` 是 Core 与高层共享的声明边界：它只接受 `Object.prototype` 或 `null` prototype 的 record，不读取继承属性，并拒绝数组、Symbol key、不可枚举 own key 与 `fields` 之外的字段。默认错误是 `TypeError`；拥有结构化错误体系的高层可用 `createError(message)` 保留自己的错误类型，而不复制校验算法。

### 2. 组合闭包

同类对象组合后仍保持原语义：

```text
Lifetime + owned resources → Lifetime
Plugin + Group → Installation
ExtensionPoint contributions + ordinary composer → Catalog / Pipeline
Manifest + Reference → Artifact → Registration → Core Installation
```

Group 机械展开到 canonical ChangeSet；Platform 和 reactive `observe()` 只能用公开 API 组合。三者都不能创建第二套 Registry 或事务状态机。

### 3. 语义正交

- Service 表达稳定能力，不广播事件。
- ExtensionPoint 保存开放贡献，不决定排序、覆盖或业务冲突策略。
- Event 表达已经发生的事实，不查询结果、不保存状态。
- Lifetime 只管理时间所有权，不解析依赖。
- Group 只管理安装所有权，不创建能力命名空间。
- Plugin 不加载其他插件；Loader 位于 Platform。
- Host 不理解 HTTP、React、数据库、窗口或文件系统。

### 4. 显式优于隐式

任何会改变能力解析、生命周期所有权或执行顺序的关系，都必须能从 Contract、Plugin 或显式参数中直接读出：

- Service 选择只由 `requires` 中的稳定 Contract ID 决定，不读取 Group、调用栈、当前 workspace 或祖先 Context；
- setup 顺序只由 Service 依赖图决定，不把安装顺序、Event、ExtensionPoint 或完成时序当作隐藏依赖；
- 资源所有权来自创建它的 Lifetime，跨边界转交必须通过普通参数或 `Disposable` 明确表达；
- 领域配置通过插件配置、方法参数或显式适配器 Service 组合，不使用全局拦截链、Proxy shadow 或原型链覆盖。

“约定默认值”可以减少样板，但不能改变上述语义。若删除一段声明后 Core 仍会从环境中猜出关系，说明抽象已经过度隐式。

### 5. 公共协议与辅助类型

公开类型服务于下游组合，不是实现残留：

| 导出 | 精确职责 |
| --- | --- |
| `Service`、`ExtensionPoint`、`Event`、`OptionalService`、`Requirement` | 三种 Contract 身份与可选 Service 依赖 |
| `ContractKind`、`ContractValue` | Contract kind 联合与值类型提取 |
| `Plugin`、`AnyPlugin`、`PluginContext`、`Awaitable` | Plugin 声明、异构集合形状、setup Context 与同步/异步返回边界 |
| `Requirements`、`ResolvedRequirement`、`ResolvedRequirements` | 声明依赖表及其解析后值类型 |
| `Provisions`、`ProvidedServices` | Service 提供声明及 setup 返回值类型 |
| `Host`、`HostOptions`、`HostStatus`、`HostSnapshot` | 执行边界、构造选项、状态与诊断快照 |
| `Installer`、`ChangeSet`、`Group`、`InstallationUpdate`、`LifecycleStatus` | 安装能力、事务、结构所有权、安装更新和 Group/Installation 共享生命周期状态 |
| `GroupSnapshot`、`SnapshotView` | 结构诊断条目与统一只读观察协议 |
| `LifetimeContext`、`LifetimeOperations`、`LifetimePhase` | Lifetime 的完整 Context、可组合操作协议与诊断阶段 |
| `Task`、`BackgroundTask`、`Cleanup` | 被拥有任务、任务回调与清理回调 |
| `Disposable`、`AsyncDisposable` | 分别供 `using` 与 `await using` 使用的同步/异步释放协议 |
| `disposeSymbol`、`asyncDisposeSymbol` | 两种释放协议唯一的跨运行时 key |
| `EventListener` | Event 监听器签名 |
| `Logger`、`isLogger` | 诊断输出端口及其唯一运行时判定器 |

## 二、能力代数

Core 只有四个能力原子和两个编排原子：

```text
能力原子
├── Service          稳定的一对一能力
├── ExtensionPoint   动态的开放贡献集合
├── Event            不保留状态的事实
└── Lifetime         资源所有权与取消

编排原子
├── Plugin   一次 setup 的能力生产者
└── Host     依赖图、事务和 Instance 编排
```

| 原子 | 保留当前值 | 动态变化 | 变化后的行为 |
| --- | ---: | ---: | --- |
| Service | 是 | 提供者拓扑可变化 | 重建消费者 |
| ExtensionPoint | 是 | 贡献可实时增删 | 通知订阅者 |
| Event | 否 | 监听器可增删 | 广播本次事实 |
| Lifetime | 不适用 | 可创建子级 | 父释放全部存活子级 |

Signal 是能力内部的值类型，不是可由 `requires` 获取的新 Contract kind。

## 三、Contract

Core 的作者入口只有六个：

```ts
import {
  createHost,
  definePlugin,
  service,
  extensionPoint,
  event,
  optional,
} from "@dougongjs/core"
```

错误类是捕获边界，不属于能力原子预算。

声明：

```ts
const DATABASE = service<Database>("app/database")
const ROUTES = extensionPoint<Route>("http/routes")
const USER_CREATED = event<User>("users/created")
```

统一规则：

- 第一个参数是稳定字符串 ID，也是执行身份；对象身份不参与匹配。
- 运行时返回值是冻结普通对象，形状只有 `{ id, kind }`；TypeScript 类型另带工厂私有的 phantom brand，使普通 `{ id, kind }` 不能在编译期冒充 Contract。该 brand 不参与运行时匹配。
- Contract 不持有执行状态，可跨应用复用。
- ID 必须非空且首尾无空白；区分大小写，不做 trim 或 Unicode 规范化。
- 同一 ID 在一个 Host 中不能同时承担两种 kind，否则抛 `CONTRACT_CONFLICT`。
- 只有成功提交的声明和 active Lifetime 的使用才登记 kind；失败的 setup、rollback 和未命中的应用代码读取不会占用 Contract ID。
- `optional()` 是 branded OptionalService 的唯一类型化构造入口，且只接受 Service；ExtensionPoint 的空 Map 本身就是合法值，Event 没有提供者概念。

固定 Contract 的同一 ID 应在代码库中只声明一次并从稳定模块导出。TypeScript 本身无法阻止两个模块为同一 ID 写出不同类型参数，因此 Dougong 仓库的架构门禁会拒绝重复的固定字符串声明；下游代码库也应执行同类静态检查。参数化 Contract family 不属于重复的固定声明。

同一种接口需要多份静态实例时，使用普通函数构造显式 Contract family，而不是引入隐式 Scope：

```ts
const workspaceStore = (workspace: string) =>
  service<Store>(`workspace/${encodeURIComponent(workspace)}/store`)

const ALPHA_STORE = workspaceStore("alpha")
const BETA_STORE = workspaceStore("beta")
```

family 函数本身是唯一声明源：类型和 ID namespace 只写一次，重复调用相同参数得到等价 ID，不依赖对象身份。提供者和消费者必须声明同一个具体 token。Contract ID 因而同时携带“能力是什么”和“选择哪一份”的稳定身份，依赖图、错误和诊断无需再解释第二张作用域树。动态且由每次请求选择的租户不应无限扩张 Installation 图，应改为一个显式接收 tenant/workspace 参数的 Service。

局部配置叠加同样使用显式 Service adapter，而不是通用 `intercept()`：

```ts
const HTTP = service<HttpClient>("http/client")
const ALPHA_HTTP = service<HttpClient>("workspace/alpha/http")

const alphaHttpPlugin = definePlugin({
  name: "workspace.alpha.http",
  requires: { base: HTTP },
  provides: { http: ALPHA_HTTP },
  setup: ctx => ({
    http: withDefaults(ctx.base, { timeout: 5_000 }),
  }),
})
```

adapter 的输入、输出和影响闭包都在普通依赖图中可见，包装策略由真正理解 `HttpClient` 类型的领域代码决定。Core 不用 Proxy 猜方法调用，也不需要一套独立的配置合并协议。

Core 刻意不提供 `extensionPoint.keyed()`、`extensionPoint.many()`、`ordered()` 或 `override()`。这些是 Catalog、Pipeline 或具体领域的组合策略，不是贡献集合原子。

## 四、Plugin

插件只有一种形态：

```ts
const usersPlugin = definePlugin({
  name: "app.users",
  config: usersConfigSchema,
  requires: {
    db: DATABASE,
    cache: optional(CACHE),
    routes: ROUTES,
  },
  provides: {
    users: USERS,
  },
  setup(ctx, config) {
    const users = createUsers({ db: ctx.db, cache: ctx.cache })

    ctx.contribute(ROUTES, "users.show", {
      method: "GET",
      path: "/users/:id",
      handler: request => users.find(request.params.id),
    })

    return { users }
  },
})
```

不支持函数插件、插件基类、装饰器或 `{ apply() }` 形态。

`Plugin` 保留单份声明的精确 config、requires 与 provides 类型。组合根需要保存不同形状的插件时，使用只擦除作者期泛型的 `AnyPlugin`：

```ts
const plugins: readonly AnyPlugin[] = [databasePlugin, usersPlugin]
for (const plugin of plugins) host.install(plugin)
```

`AnyPlugin` 不是另一种插件，也没有第二条执行路径；它只用于保存已经由 `definePlugin()` 定义好的值，不是原始对象字面量的作者期输入类型。安装边界仍会按同一套规则重新校验并规范化声明。

### 4.1 `requires`

依赖 alias 成为 Context 的 own property：

```ts
requires: {
  primary: PRIMARY_DATABASE,
  analytics: ANALYTICS_DATABASE,
}

// setup
ctx.primary
ctx.analytics
```

没有 `ctx.get(string)`、Service Locator、Proxy、原型链注入或模块声明合并。

Service alias 得到稳定值；ExtensionPoint alias 得到稳定的 `ContributionView` 对象。Context 和 `ctx.meta` 浅冻结，但 Service 值本身不被代理或冻结。

同一个 Plugin 内，每个 Contract ID 只能声明一次。两个 alias 不能引用同一份能力，一个 Contract 也不能同时出现在 `requires` 与 `provides`；这些歧义会在 `definePlugin()` 边界立即以 `TypeError` 拒绝，而不是留到依赖图或 setup 阶段猜测调用者意图。

保留 alias：

```text
signal meta log cleanup lifetime spawn on emit contribute
```

### 4.2 `provides`

Service 只有一个发布入口：声明 `provides`，并从 setup 返回同名 own property。

```ts
provides: { database: DATABASE },
setup() {
  return { database }
}
```

缺少声明的输出抛 `SERVICE_NOT_RETURNED`。即使现成值来自应用代码，也应包装成普通 Plugin；Core 不提供 `host.provide()` 分支。

### 4.3 配置

配置接受 Standard Schema，并区分输入与输出：

```ts
StandardSchemaV1<ConfigInput, Config>
```

- `install(plugin, input)` 接收 `ConfigInput`。
- `setup(ctx, config)` 接收校验或转换后的 `Config`。
- Schema 可以异步校验。
- 配置结果只用 own `value` / `issues` 判别成功与失败，不读取原型链；失败抛含冻结 `issues` 的 `ConfigValidationError`。
- Schema 结果必须是含 `value` 的成功对象，或含数组 `issues` 的失败对象；畸形 issue、message 或 path 会在 setup 前以精确 `TypeError` 拒绝。
- Core 不克隆或深冻结配置；防御性转换属于 Schema。

`definePlugin()` 在定义期校验并规范化声明。Plugin 本身必须是仅含 `name`、`config`、`requires`、`provides`、`setup` 的普通 record；未知字段、Symbol、隐藏属性和类实例都会被拒绝。配置 Schema 必须完整声明 Standard Schema V1 的 `version`、`vendor` 与 `validate`；`requires` 与 `provides` 也必须是仅含可枚举字符串 own key 的普通 record，不能用数组、Map 或类实例表达声明。ChangeSet 在安装与更新边界重新规范化，防止 JavaScript 调用方绕过工厂。

## 五、Context API 预算

无依赖时，Context 只有：

```ts
ctx.signal
ctx.meta
ctx.log

ctx.cleanup(disposer)
ctx.lifetime(label)
ctx.spawn(task)
ctx.on(event, listener)
ctx.emit(event, payload)
ctx.contribute(point, localKey, value)
```

`ctx.signal` 是标准 AbortSignal。`ctx.meta` 是冻结的 `InstanceMeta`：

```ts
interface InstanceMeta {
  hostName: string
  pluginName: string
  installationId: string
  groupId: string
}
```

`ctx.log` 仍使用 Host 提供的 Logger，但 Core 会把当前冻结的 `InstanceMeta` 作为第一项 detail 传入，因此日志端无需从消息文本猜归属。它是 Lifetime 可撤销的窄 facade：cleanup 期间仍可记录，Lifetime 终止后会切断 Runtime/Logger 引用并以 `LIFETIME_DISPOSED` 拒绝继续使用。Logger 的四个成员是严格函数属性；会丢弃 `unknown` message 或 rest details 的窄实现不能通过类型检查。

文件系统、网络、窗口、剪贴板、存储、通知和路由器都应声明为 Service，不得成为 Context namespace。

Context 不提供 `effect()`、`observe()` 或 `using()`：

- `using(ctx, resource)` 可以机械展开为 `ctx.cleanup(() => dispose(resource))`。
- reactive `observe(ctx, source, listener)` 可以由 `get/subscribe + lifetime/spawn/cleanup` 完整实现。
- 两者位于更高层，Core 不需要私有特权。

## 六、Service

Service 是 Instance 生命周期内的稳定快照：

```ts
const db = ctx.db
db === ctx.db // 该实例存活期间恒为 true
```

禁止 live Service Proxy。提供者更新时，Host：

```text
预校验候选图与配置
→ 逆序停止受影响消费者
→ 停止旧提供者
→ 启动新提供者
→ 按依赖顺序重建消费者
```

`optional(SERVICE)` 也遵循快照语义。提供者从不存在变为存在或反向变化时，消费者实例会重建，不会修改活着的 Context。

Host 外部和测试边界可以读取：

```ts
const users = host.get(USERS)
const cache = host.get(optional(CACHE)) // Cache | undefined
```

`host.get()` 只接受 Service 或现有的 `optional(Service)` 包装，并且只在 Host 为 active 时读取。必需 Service 当前不可用时抛 `SERVICE_UNAVAILABLE`；optional Service 没有 provider 时返回 `undefined`。Plugin 内部仍只能使用声明依赖。Core 不增加语义重复的 `tryGet()`。

Host 缓存已提交执行状态对应的已验证依赖图；`host.get()` 只做 provider 与 Service Map 查询，不重新构图。idle 状态允许分步安装暂时不完整的计划，因此只在 `start()` 或 Host active 时提交的 ChangeSet 中构造候选图。

Host active 时执行 ChangeSet 会明确进入 `changing`，应用代码的 `host.get()` 暂时拒绝读取；它不会在旧 Instance 停止、新 Instance 启动的窗口中伪装成稳定的 active。事务成功或 rollback 完成后才重新进入 `active` 并切换对应图；无法恢复则 fail closed 到 `idle`。因此应用代码的读取边界只存在“提交前”和“提交后”，候选图或半重建的 Service Map 都不会泄漏。

### 6.1 启动调度

依赖图使用确定性的拓扑层：同一层没有 Service 依赖关系，可以并发 setup；下一层必须等待上一层完整提交。每层分为两个阶段：

```text
prepare: 并发创建 Lifetime、解析依赖、执行 setup、校验 Service 输出
commit:  整层成功后按稳定安装序发布 Service / Listener / Contribution
```

任一 setup 失败会 abort 同层其余 setup 的 `ctx.signal`，等待所有同层 setup 落定，并释放所有已 prepare 的 Lifetime。失败层公开零项新能力；已经提交的前置层由外层启动或 ChangeSet 回滚边界统一清理。

并发只来自显式 Service 依赖图。Event 和 ExtensionPoint 不建立启动边，独立插件的 setup 先后与完成顺序未定义；需要顺序就声明一个 Service 依赖，不能依赖安装顺序或定时。停止仍按完整依赖图逆序串行执行，以保持确定的资源撤销顺序。

Core 当前不提供并发上限配置。它没有第二种调度模式，也没有在缺少数据时预设进程级策略；需要限制某类昂贵操作时，由相应 Service 自己提供队列或 semaphore，因为它才知道资源类型和真实容量。

## 七、ExtensionPoint

### 7.1 原子模型

所有 ExtensionPoint 都是：

> 由 Instance 拥有、以稳定局部 key 标识的动态贡献 Map。

```ts
const ROUTES = extensionPoint<Route>("http/routes")

const contribution = ctx.contribute(ROUTES, "users.show", route)
contribution.update(nextRoute)
contribution.dispose()
```

真实 key 由 Core 组合：

```text
<escaped installation id>/<escaped local key>
```

其中 `%` 与 `/` 分别转义为 `%25` 与 `%2F`，因此分隔符不会让两组不同的 installation ID / 局部 key 组合产生同一个真实 key，同时常见 key 仍保持可读。

这个 key 只表达所有权身份，不是领域 ID，重装后也会变化。消费者应把命令 ID、排序权重等领域数据放进 value，并显式校验冲突或排序；不能依赖 Map 的真实 key 或插入顺序表达领域策略。

因此：

- 不同插件使用相同局部 key 不冲突；
- 同一 installation、同一局部 key 只能有一个存活贡献；
- 更新必须通过原 `Contribution`；
- `undefined` 是合法贡献值，存活性由真实 key 与记录身份决定，不用值充当终态哨兵；
- 旧 `Contribution` 使用记录身份校验，不能删除后来创建的同 key 贡献；
- Instance 停止时自动删除全部贡献；
- setup 失败不会发布贡献。

### 7.2 统一观察协议

```ts
interface ContributionView<T> {
  get(): ReadonlyMap<string, T>
  subscribe(listener: () => void): Disposable
}
```

`subscribe()` 只通知未来失效，不立即调用，也不携带值。调用方显式执行“读当前值，再订阅未来”：

```ts
const rebuild = () => {
  router.replace([...ctx.routes.get().values()])
}

rebuild()
ctx.routes.subscribe(rebuild)
```

从 Context 获得的 ContributionView 会把订阅自动归当前 Lifetime 所有；提前释放仍使用返回值的 `dispose()`。

应用代码可从同一 committed Store 取得 Host 拥有的稳定视图：

```ts
const routes = host.contributions(ROUTES)
const subscription = routes.subscribe(render)
await host.start()
render()
```

该视图可在启动前创建，并跨 stop/start 保持身份；它只呈现已提交快照，订阅的 `Disposable` 由调用方所有。调用同时把 Contract ID 作为 ExtensionPoint 身份登记，因此同一 Host 后续不能用另一种 Contract kind 复用该 ID。Plugin 内部仍只能通过 `requires` 获取受 Lifetime 约束的视图。跨重启的稳定身份也意味着保留该 View 会有意保留所属 Host 的观察链路；应用应让它与 Host 一同退出作用域，而不是把它放进更长寿的全局缓存。

快照是真正只读的 Map，没有 `set/delete/clear`。无变化时保持对象身份；提交变化时创建新快照。一次 Core ChangeSet 内同一 ExtensionPoint 无论改变多少次，只通知一次。

ContributionView 是 Plugin Lifetime 拥有的 live capability，而不是可永久泄漏的 Store 引用。Instance 停止后，旧 View 的 `get/subscribe` 会拒绝使用并切断对 Store 的引用；新 Instance 会获得新 View。View 的公开 `get/subscribe` 由只持有可撤销 binding 的窄 facade 提供，不能用在 Store 方法作用域中创建的箭头函数暗中捕获 Store。这个边界与旧 Service 闭包的处理不同：Service 是一次解析出的普通值，ContributionView 则持续观察已提交贡献。

后续订阅者抛错进入 Host `onError`，不能破坏产生通知的 Host 命令；首次读取与 Plugin 自己的同步 `rebuild()` 错误仍正常使 setup 失败。

### 7.3 高层组合

领域唯一性、排序、覆盖和折叠必须基于原始贡献组合：

```text
ExtensionPoint<Command> + keyOf(command.id) + conflict policy → CommandCatalog Service
ExtensionPoint<Middleware> + orderBy(order) + reduceRight    → Middleware Pipeline
ExtensionPoint<Theme> + keyOf(theme.id) + stack policy       → ThemeCatalog Service
```

这些组合器可以提供更适合领域的 API，但其输入必须是公开 ContributionView，生命周期必须使用公开 cleanup/subscribe，不能访问内部 ContributionStore。

## 八、Event

```ts
const TRACK_CHANGED = event<Track>("playback/track-changed")

const subscription = ctx.on(TRACK_CHANGED, listener)
await ctx.emit(TRACK_CHANGED, track)
subscription.dispose()
```

每次 `on()` 都创建一份独立 Listener 注册；即使复用同一个函数，释放其中一份也不会撤销另一份。

Event 只有一种派发语义：

- 单 payload；复杂参数使用对象；
- 异步并发广播全部监听器；
- 等待全部完成；
- 不返回业务结果；
- 任意监听器失败时抛 `AggregateError`，即使只有一个原因；
- 监听器自动归创建它的 Lifetime 所有；
- setup 期间注册的监听器在 setup 成功前不可见。

`emit()` 始终以 Promise 报告失败，包括 Lifetime 已停止、Contract 非法等调用边界错误；所以 `void ctx.emit(...).catch(report)` 能同时覆盖派发前与监听器阶段。`Event<void>` 可写成 `ctx.emit(READY)`，无需显式传 `undefined`。

如果需要结果，使用 Service；如果需要有序处理链，使用 ExtensionPoint + 普通函数；如果需要当前状态，使用 Service 暴露 Readable/Signal。

Event 不重放。初始状态必须由 Service getter、Signal/Readable 或 ExtensionPoint 当前快照承载，不能在 setup 中 emit 一个“初值”并依赖其他插件恰好已经提交监听器。

Event 是事实而不是状态，因此一次 `emit()` 本身不可回滚。setup 中产生的外部副作用也应由插件负责补偿；Core 的事务承诺针对框架可见的 Service、Contribution 和 Listener。

## 九、Lifetime 与 Disposable

每个 Instance 天然拥有一个根 Lifetime。所有通过 Context 创建的监听、贡献、订阅、任务、子 Lifetime 和 cleanup 都自动归它所有。

释放操作统一为 `dispose()`，时序则由两个严格协议显式区分：

```ts
interface Disposable {
  dispose(): void
  [Symbol.dispose](): void
}

interface AsyncDisposable {
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
```

所有资源统一用 `dispose()` 释放；Installation 从计划中删除统一用 `remove()`。两者不能混用。

同步资源可用于 `using`，需要等待的 Lifetime、Task 与 cleanup 可用于 `await using`。Symbol 方法是同一 `dispose()` 操作对 JavaScript 语法的协议投影，不拥有第二套状态机或错误语义。Dougong 会为缺少 well-known Symbol 的运行时选择稳定的协议 key，但不会修改全局对象；因此显式 `dispose()` 始终可用，而 `using` 需要运行时原生支持或由应用预先 polyfill 对应 Symbol。

实现 Dougong 的结构化释放协议时必须使用 Core 导出的 canonical key，不能再次判断运行时：

```ts
import { asyncDisposeSymbol, type AsyncDisposable } from "@dougongjs/core"

class Session implements AsyncDisposable {
  async dispose() {}
  [asyncDisposeSymbol]() { return this.dispose() }
}
```

两个值在运行时有原生 well-known Symbol 时直接引用它，否则使用对应的全局 Symbol registry key。Platform 与 Core 资源因此使用同一协议身份；独立且零依赖的 Reactive 包保留自己的等价基础声明。

### 9.1 cleanup

```ts
const cleanup = ctx.cleanup(() => server.close())
await cleanup.dispose() // 可提前释放，幂等
```

cleanup 按注册逆序执行；某项失败不会跳过更早资源。一个失败原样抛出，多个失败聚合。

### 9.2 子 Lifetime

```ts
const session = ctx.lifetime("session")

session.on(MESSAGE, listener)
session.spawn(signal => pump(signal))
session.cleanup(() => transport.close())

await session.dispose()
```

- 父释放所有仍存活的子级；
- 子释放不影响父；
- 提前释放的子级从父拥有集合中脱离；
- `dispose()` 幂等；
- 父 Context 与子 Lifetime 使用相同资源 API。
- `label` 是必填、非空且首尾无空白的诊断描述，不参与执行查找或身份判定；同级重名合法。
- 主动释放 Lifetime 或 Task 会用冻结的 `AbortError` 取消其 signal；父级取消仍显式转发父 signal 的 reason。取消判定必须先确认 signal 已 aborted，再接受与 `signal.reason` 相同的值或标准 `AbortError`；不能单独依赖其中任何一项。
- 释放进行中的重复 `dispose()` 共享同一个完成 Promise；进入终态后的重复调用只是已完成的无操作。发起释放的调用方仍收到原始失败，但终态资源不继续保存已拒绝 Promise 或错误栈。Lifetime 完成释放后以一个新的 aborted signal 和共享的无状态 `AbortError` 表达终态，从而同时切断旧 signal 的监听器闭包与可能携带应用对象的历史 reason。

### 9.3 spawn

```ts
const task = ctx.spawn(signal => synchronize({ signal }))
await task.result
await task.dispose()
```

释放任务先 abort，再等待结果 settle。未被调用方同步处理的后台失败通过 Host `onError` 上报。只有与 `signal.reason` 相同的拒绝值或明确的 `AbortError` 才分类为取消；仅仅发生在 abort 之后的其他失败仍会上报，避免把取消期间的真实收尾故障静默吞掉。

`isCancellationReason(signal, error)` 是这条规则唯一的公开判定器，Platform Loader 和下游适配器复用它，而不是各自复制一份“看起来像取消”的启发式逻辑。

任务自然 settle 后会立即从父 Lifetime 的拥有集合和 AbortSignal 监听器中脱离；之后调用该 Task 的 `dispose()` 只是幂等完成，不会追溯性 abort 已结束任务的 signal。已完成任务不会在长生命周期中按历史次数累积；父释放仍会 abort 并等待当时尚未 settle 的全部任务。

### 9.4 停止顺序

Instance 停止时顺序固定，不依赖注册巧合：

```text
拒绝新 Context 工作
→ 撤销 Service
→ 撤销 Listener、Contribution 与 ExtensionPoint 订阅
→ abort 根 signal
→ 等待后台任务
→ 逆序释放子 Lifetime
→ LIFO 执行 cleanup
```

因此 cleanup 中不能继续 `emit()` 或申请新资源；停止已经越过“接受新工作”边界。

## 十、Host 与 ChangeSet

```ts
const host = createHost({
  name: "desktop",
  logger,
  onError,
})
```

Host options 是仅含 `name`、`logger`、`onError` 的普通 record；只读取可枚举 own property，未知字段、Symbol、隐藏属性、数组与类实例都会立即拒绝。`logger` 与 `onError` 本身仍是结构化端口，可以由普通对象或类实例实现。

`Installer` 精确表示“能安装到一个所有权位置”的能力，包含 `install/group/change`，并由 Host 与 Group 实现。只需要事务入口的高层协作者应在消费侧声明 `Pick<Installer, "change">`，不能把缺少安装能力的窄端口命名为 Installer。

### 10.1 安装与启动

```ts
const database = host.install(databasePlugin, config)
host.install(usersPlugin)

await host.start()
await database.ready()
```

`install()` 同步返回稳定 `Installation`，并把单项 ChangeSet 排入 Host 命令队列。Plugin 形状错误同步抛出；提交或启动错误由 `ready()` / `start()` 暴露。

`ready()` 的屏障位于整笔命令之后：候选图验证、Instance 切换和 ExtensionPoint 批次发布全部结束后才 settle。调用方在 `await installation.ready()` 后立即读取 ContributionView 时只能得到已提交快照，不需要额外等待一个 tick。

命令队列线性化 install、update、remove、start 和 stop。一次失败不会破坏后续命令排队能力。

Core 用唯一的 `SerialQueue` 表达这条语义，Platform 的变更与激活队列也复用同一原语：

```ts
const commands = new SerialQueue()
const result = commands.run(operation) // 调用方收到自己的值或错误
await commands.settled                 // 等待读取时已经排入的全部操作
```

`run()` 无论前一项成功还是失败都会继续执行下一项；内部 tail 只记录完成边界且永不 reject，单项原始结果只返回给对应调用方。它是 Host 和高层编排器共享的命令串行协议，不拥有 Host、事务或错误分类状态。

### 10.2 Installation

```ts
installation.status
installation.ready()
installation.update({ plugin })
installation.update({ config })
installation.update({ plugin, config })
installation.remove()
```

`update()` 同时覆盖配置与 Plugin 声明替换，参数必须是仅含可枚举 `plugin` / `config` own property 的普通 record，并且至少包含其中之一；未知字段、Symbol、隐藏属性、数组与类实例都会立即拒绝。这里不提供 `replace/reload/restart`。Plugin 更新不能改变 name；Installation 及其 ID 保持稳定，活动 Instance 被替换。

Installation 进入 `removed` 后撤销对 Host 的控制引用并释放 Plugin 声明与配置。终态 `remove()` 幂等成功，`update()` 以 `INSTALLATION_REMOVED` 拒绝；保留一个已删除 Installation 不会反向保活 Host。

Installation 在提交前失败时，已经等待 `ready()` 的调用方仍收到原始 `Error`；setup 或配置校验器抛出非 `Error` 值时，首次公开命令与稳定失败状态共享同一个 `INSTALLATION_UNAVAILABLE` 错误，原值保存在 `cause`。Installation 脱离 Host 后，只保留错误的 `name/message/code` 纯数据摘要，后续 `ready()` 在调用边界重建错误。JavaScript `Error` 的调用栈可能保留整个编排对象图，不能成为终态 Installation 的隐藏所有权边。仍附着于活动 Host 的失败 Installation 继续保留原始错误，供诊断和重试语义使用。Platform 的终态 Registration 遵守相同规则。

### 10.3 canonical ChangeSet

```ts
const change = host.change()
change.update(provider, { plugin: providerV2 })
change.update(consumer, { plugin: consumerV2 })
change.remove(legacy)
const extra = change.install(extraPlugin)
await change.commit()
```

规则：

- one-shot；首次 `commit()` 后封口；
- commit 幂等，重复调用返回同一 Promise；
- 空 ChangeSet 不制造伪 `changing` 状态或诊断 revision，但仍按提交顺序经过 Host 命令队列与 owner authority 边界；先提交的 Group 删除会使随后提交的旧空草稿以 `GROUP_REMOVED` 拒绝；
- 同一 Installation 在一份 ChangeSet 中只能出现一次；
- 拒绝其他 Host 的 Installation；
- 候选依赖图和全部受影响配置在停止任何实例前完成校验；
- 执行期间 Host 为 `changing`，应用代码的 Service 读取关闭；
- active 变更只重建目标和新旧图中受影响的传递消费者；
- 多项变更共用一份停止、启动、回滚与 ExtensionPoint 通知边界。

`change.install()` 返回的是该 ChangeSet 独占的 draft Installation。调用 `commit()` 时它才获得 Host 控制权限；commit 前直接调用其 `update/remove`，或把它作为另一份 ChangeSet 的目标，都会以 `INSTALLATION_UNAVAILABLE` 拒绝。已删除或失败后脱离 Host 的 Installation 同样不能重新进入 ChangeSet。`host.install()` 之所以返回即可控制的 Installation，是因为该语法糖在返回前已经同步提交了内部单项 ChangeSet。

`install()` 返回需要保留的 draft Installation；`update()` 与 `remove()` 只暂存命令并返回 `void`。ChangeSet 因而刻意不采用半链式 API：逐项写入，再单独 `commit()`。

变更 setup 失败时，Core 释放部分 activation 并恢复旧图。若旧资源无法停止、部分 activation 无法清理或旧图无法恢复，Host fail closed 到 idle，不谎报 active。

### 10.4 stop

`host.stop()` 按依赖逆序停止。停止后安装计划仍在，Installation 回到 `pending`；再次 `start()` 会按当前 Plugin 声明和配置创建新 Instance。`remove()` 才会从计划删除。

## 十一、Group

Group 是安装组合和子树所有权，不是第七个内核原子，也不是依赖注入 Scope：

```ts
const backend = host.group("backend", group => {
  group.install(databasePlugin, config.database)
  group.install(usersPlugin)
  group.group("transport", transport => {
    transport.install(httpPlugin, config.http)
  })
})

await backend.ready()
await backend.remove()
```

Host 与 Group 使用同一组 `install/group/change` 动词，并共同实现 `Installer`。供 Platform 等只编译事务的高层内部协作者使用消费侧的 `Pick<Installer, "change">`，无需伪造未使用的能力。首次 configure 必须同步，以便所有声明编译进一份 ChangeSet；返回 thenable 会立即拒绝。

Group 的规则：

- 可嵌套；
- configure 内全部安装共享一次提交；
- `ready()` 等待 configure 产生的安装越过 ready barrier；
- `remove()` 用一次 Core 事务删除整棵子树；
- Group ChangeSet 只能修改自身子树的 Installation；
- Group 与 Installation 共享 `status/ready/remove`，只有 Installation 增加 `update`；
- Group 不改变能力可见性：Service、ExtensionPoint 和 Event 都属于整个 Host。

嵌套 Group configure 共享同一个显式配置会话。任一子级失败都会把整份会话置为 `failed`，即使调用方在外层捕获了该异常，也不能继续向已经失败的草稿追加声明或提交部分配置。非 `Error` 的失败值在配置和运行事务边界统一分类为 `GROUP_UNAVAILABLE`；`ready()` 失败后 Group 状态必须是 `failed`，不能因为失败值恰好为 `undefined` 而呈现为健康。

每个 Group 只保留一份当前 readiness barrier。尚未成功建立的 Group 在提交失败后保持 `failed`，后续成功变更会替换旧 barrier 并建立 Group；已经建立的 Group 若变更失败且 Core 恢复了原提交状态，则继续保持健康。`status` 与 `ready()` 始终读取同一份生命周期状态。

删除 Group 会同时撤销整棵子树的权限，包括删除前已经创建但尚未提交的 ChangeSet；这些旧草稿的后续 `install/update/remove/commit` 都统一以 `GROUP_REMOVED` 拒绝，不能越过 Group 边界进入 Host。终态 Group 只保留身份和 `removed` 状态，`remove()` 幂等；它不再持有 Host、配置会话或历史失败调用栈，也不能创建 Installation、子 Group 或 ChangeSet。

需要工作区或租户区分时，根据语义选择：固定且需要独立依赖图的少量实例使用显式 Contract family；请求期选择的数据使用带 tenant/workspace 参数的 Service；完全独立的能力图使用多个 Host；安全隔离使用 Worker/iframe/进程。不要把 Group 冒充解析或安全边界。

## 十二、事务发布

单个拓扑层启动：

```text
1. 校验配置
2. 为层内每个插件解析稳定 Service 快照与 ContributionView
3. 创建各自根 Lifetime，并发执行 setup
4. 暂存 Contract kind、Listener 与 Contribution；cleanup 立即进入各自回滚栈
5. 校验整层全部 Service 输出
6. 整层成功后按稳定安装序注册 Service、发布暂存能力
7. 标记整层 active，再进入下一拓扑层
```

prepare 阶段失败时：

```text
公开 Service       0
公开 Contribution  0
公开 Listener      0
已登记 Contract kind 0
已取得资源          全部尝试释放
```

Host start、stop 和 active 状态下提交的 ChangeSet 使用 ExtensionPoint 批次：观察者只能看到操作前或操作后的快照，不看到逐插件半成品。

## 十三、统一观察协议与 reactive 层

ContributionView、Host diagnostics、Platform diagnostics 和 `@dougongjs/reactive` Signal 统一采用结构协议：

```ts
interface Readable<T> {
  get(): T
  subscribe(listener: () => void): Disposable
}
```

生产这类运行诊断时使用 Core 唯一的写侧原语 `SnapshotPublisher`：

```ts
const snapshots = new SnapshotPublisher(readSnapshot, reportError)

export const diagnostics = snapshots.view // 只暴露 get / subscribe
snapshots.invalidate()                     // 标记失效并通知
snapshots.dispose()                        // 固化终态并切断闭包
```

`view` 是权限收窄，不是第二套观察 API：读取方只能 `get/subscribe`，拥有方只能通过 `SnapshotPublisher` 驱动失效和终止。每次订阅都有独立身份；释放会立即撤回尚未轮到的通知。订阅者失败交给显式 reporter 后仍继续通知其余订阅者；若 reporter 自身失败，Publisher 完成整轮通知后用 `AggregateError` 同时保留订阅者错误与 reporter 错误。`dispose()` 会在切断 reader、reporter 与现有订阅前固化最后一份快照；历史 view 因而仍可读取终态，但不能反向保活拥有方。Host、Lifetime 与 Platform diagnostics 直接走这条路径；`ContributionStore` 同样组合这一个 Publisher，只在订阅外层增加 Lifetime 所有权，因而重复注册同一个函数仍是两份独立订阅。任何高层都不得重写订阅注册表和错误边界。

快照需要 Map 语义时统一使用 `ReadonlyMapSnapshot`。它只接受类型声明中的 Map 或条目 iterable，复制输入并只暴露 `ReadonlyMap` 方法，避免 `Object.freeze(new Map())` 仍可调用 `set/delete/clear` 的伪不可变性；它只保证容器结构不可变，条目值仍应在进入快照时自行冻结。

`@dougongjs/reactive` 是独立基础包：

```ts
signal(initial)
computed(calculate)
batch(callback)
observe(lifetimeOwner, source, observer)
```

- Signal 保存当前值；
- computed 自动追踪仅用于同步、纯、懒、缓存计算；
- batch 只接受同步 callback，并按订阅身份合并 callback 内的重复通知；
- observe 是更高层的 Lifetime 组合器：显式读取一个 source，为当前值创建子 Lifetime，变化时先释放旧子级再创建新子级；observer 必须同步，后续替换失败会停止观察并释放订阅与当前子 Lifetime。

```ts
const endpoint = computed(() => `${base.get()}/${account.get()}`)

observe(ctx, endpoint, (url, lifetime) => {
  const socket = new WebSocket(url)
  lifetime.cleanup(() => socket.close())
})
```

`observe()` 只使用公开 `get/subscribe/lifetime/spawn/cleanup`，因此不是 Core 特权或第二套执行引擎。Core 不依赖 reactive，第三方 Readable 也可结构兼容。

结构兼容只统一观察协议，不抹平资源来源的所有权边界：Context 注入的 ContributionView 是绑定当前 Lifetime 的 live capability，直接 `subscribe()` 产生的订阅会自动归该 Lifetime 所有；独立 Signal 或第三方 Readable 没有隐含 owner，直接订阅时由调用方持有返回的 Disposable，或交给 `observe(owner, source, observer)` 组合进显式 Lifetime。两者仍只有同一个 `subscribe()` 和同一个 `dispose()`，差异只在是否已经存在明确的结构化 owner。

不提供 Solid 式裸 `effect()`、依赖数组、深层 Proxy Store、`watchEffect/autorun/reaction`。Effect-TS 可以在 Service 内使用或经单向适配器接入，不进入 Core。

## 十四、诊断与封装边界

```ts
host.diagnostics.get()
host.diagnostics.subscribe(notify)
```

快照包含 Host name/status/revision、InstallationSnapshot Map 和 GroupSnapshot Map。若条目含最近失败，其 `error` 精确标注为 `Error`，因为状态机已经在写入诊断前完成非 Error 值的分类。快照、条目、数组与 Map 都只读；诊断不能控制 Host。

运行中的 `InstallationSnapshot` 还包含一份独立的 `lifetime` 观察视图：

```ts
interface LifetimeSnapshot {
  readonly label: string
  readonly phase: "active" | "disposing" | "disposed"
  readonly cleanups: number
  readonly tasks: number
  readonly listeners: number
  readonly contributions: number
  readonly contributionViews: number
  readonly subscriptions: number
  readonly children: readonly LifetimeSnapshot[]
}

const lifetime = host.diagnostics.get().installations.get(id)?.lifetime
const current = lifetime?.get()
const subscription = lifetime?.subscribe(render)
```

根节点的 `label` 是稳定的 installation ID；每个 `children` 条目严格对应一次真实的 `lifetime(label)` 所有权关系。节点计数只描述该 Lifetime 直接拥有的资源，`children` 只列直接子 Lifetime。子树总量可由这组不可再约简的事实递归推导，不在快照中保存第二份聚合状态。整棵快照递归冻结，但不暴露 Lifetime、资源对象、回调或 Store。

label 只回答“这组资源为何共同存活”，不是 capability ID、查找 key 或新的 Scope。重复 label 不产生冲突，也不改变释放语义。cleanup、task、listener 等叶资源不各自增加命名重载；只有确实存在共同释放边界时才创建子 Lifetime。Core 不从函数名、调用栈或序号猜测节点，也不为了实现分类计数伪造树层级。

资源变化只更新这份小型视图，不增加 Host revision，也不重建全部 InstallationSnapshot；调用方要观察资源变化就显式订阅嵌套视图。子 Lifetime 终止后立即从树中摘除；Instance 停止后新的 InstallationSnapshot 不再含 `lifetime`，已经取得的旧视图会停在无子节点、全零计数的 `disposed` 终态，且不再保留 Host。

公共 facade 对象与顶层 Host / Platform 都经过冻结且保持狭窄。纯 JavaScript 检查自有属性或原型，也不会看到：

```text
InstallationRecord
GroupNode
ContributionStore
EventHub
LifetimePort
ChangeSet port
ChangeSet discard / Installation attach / revoke
Host 的 Group 编排端口
staged publication method
Platform Artifact / Core Installation
```

TypeScript 的 `private` 不被当作安全措施；实现使用真正的 `#private` 字段或独立 facade 对象，防止 JavaScript 形状泄露。

Context 限制同样不是安全沙箱。同 Realm 插件仍可访问 `globalThis`、DOM 或 fetch。不可信插件必须进入 Worker、iframe、受限 Realm 或独立进程。

## 十五、错误约定

编程形状错误使用 `TypeError`。可判定模型错误使用 `DougongError.code`：

| code | 含义 |
| --- | --- |
| `CONFIG_INVALID` | Standard Schema 拒绝配置 |
| `CONTRACT_CONFLICT` | 同一 ID 承担多个 kind |
| `SERVICE_CONFLICT` | Service 有多个提供者 |
| `SERVICE_MISSING` | 必需 Service 无提供者 |
| `SERVICE_CYCLE` | Service 依赖环或自依赖 |
| `SERVICE_NOT_RETURNED` | setup 未返回声明输出 |
| `SERVICE_UNAVAILABLE` | 外部读取或 Instance 绑定当前不可用 |
| `INSTALLATION_REMOVED` | 操作已从计划移除的实例 |
| `INSTALLATION_UNAVAILABLE` | Installation 无法进入可等待状态 |
| `INSTALLATION_IDENTITY` | update 试图改变插件 name |
| `GROUP_REMOVED` | 操作已移除的 Group |
| `GROUP_UNAVAILABLE` | Group 尚未成功建立 |

Event 因定义要求收集全部监听器失败，总是抛 AggregateError。Lifetime 与关停先尝试所有资源：一个失败原样抛出，多个失败聚合。rollback/fail-closed 跨多个阶段时统一使用 AggregateError。

后台任务、订阅者和后续 observe 的错误无法回到原同步调用栈，通过 `onError` 上报。`onError` 自身失败也不得改变正在观察的 Host 命令。

## 十六、禁止方向

- 插件基类和框架继承树；
- 装饰器依赖注入与字符串 Service Locator；
- Proxy Context、原型链 shadow、live Service Proxy；
- Core 内置 Signal/effect、React、HTTP、Node、文件系统或定时器；
- `extensionPoint.keyed/many/ordered/override` 等领域策略进入 Core；
- Scope 与 Group 混为一谈；
- lifecycle hook 矩阵；
- Event 增加 serial/bail/waterfall 等查询模式；
- Plugin 任意修改全局 Installation 图；
- Loader、Manifest、HMR 或权限进入 Core；
- 用 Context API 限制冒充安全沙箱；
- 只在类型声明隐藏、但在 JavaScript 对象上泄露内部字段或方法。

## 十七、最终判据

任何新需求先回答：

1. 它是稳定能力、开放贡献、瞬时事实还是资源？
2. 能否由 Service、ExtensionPoint、Event、Lifetime 和普通函数组合？
3. 是否真的需要修改 Core？
4. 同层是否已经存在语义等价入口？
5. 高层实现能否只使用公开 API？
6. 组合后是否保持原生命周期、事务和错误语义？
7. 是否泄露内部 Registry、Host、安装状态对象或安全假象？
8. 去掉 React、Node、Wails 和 reactive 包后，Core 是否仍成立？

设计公式：

```text
Plugin =
  setup(
    immutable service snapshot,
    live ContributionView,
    config,
    lifetime,
  )
  →
  atomic service outputs
  + owned contributions
  + owned listeners
  + owned resources
```

用户只需记住三句话：

```text
插件通过 requires 获得能力，通过 return 提供 Service，通过 contribute 加入开放扩展。
所有监听、贡献、任务和 cleanup 自动属于创建它们的 Lifetime。
Service 变化重建消费者，ExtensionPoint 变化通知订阅者，Event 只广播本次事实。
```
