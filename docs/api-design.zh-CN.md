# Dougong Core API 设计规范

本文是 `@dougong/core` 的可观察行为规范。实现与本文冲突时，应治本式修改实现或规范，不增加兼容别名。

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
| 发布 Service | `provides` + setup 返回值 | `ctx.provide` / `app.provide` |
| 贡献 Extension | `contribute()` | `add` / `append` / `register` |
| 监听 Event | `on()` | `listen` / `hook` |
| 发送 Event | `emit()` | `dispatch` / `publish` / `fire` |
| 注册清理 | `cleanup()` | `using` / `own` / `defer` |
| 创建子生命周期 | `lifetime(label)` | `child` / `scope` / `fiber` |
| 启动后台任务 | `spawn()` | `run` / `fork` / `task` |
| 读取实时值 | `get()` | `.value` / 函数调用 / `getSnapshot()` |
| 订阅变化 | `subscribe()` | `watch` / `listen` / `observeChanges` |
| 更新插件 | `update()` | `replace` / `reload` / `restart` |
| 删除安装 | `remove()` | `uninstall` / `delete` |
| 释放资源 | `dispose()` | `close` / `destroy` / `off` |

`app.install()`、`handle.update()` 和 `handle.remove()`是单目标语法糖，内部只创建一份 one-shot ChangeSet 并提交。它们不拥有第二套校验、队列或回滚逻辑。

### 2. 组合闭包

同类对象组合后仍保持原语义：

```text
Lifetime + owned resources → Lifetime
Plugin installations + Group → InstallationHandle
Extension contributions + ordinary composer → Catalog / Pipeline
Core plugins + Manifest / Loader → managed external plugin
```

Group 机械展开到 canonical ChangeSet；Platform 和 reactive `observe()` 只能用公开 API 组合。三者都不能创建第二套 Registry 或事务状态机。

### 3. 语义正交

- Service 表达稳定能力，不广播事件。
- Extension 保存开放贡献，不决定排序、覆盖或业务冲突策略。
- Event 表达已经发生的事实，不查询结果、不保存状态。
- Lifetime 只管理时间所有权，不解析依赖。
- Group 只管理安装所有权，不创建能力命名空间。
- Plugin 不加载其他插件；Loader 位于 Platform。
- Application 不理解 HTTP、React、数据库、窗口或文件系统。

### 4. 显式优于隐式

任何会改变能力解析、生命周期所有权或执行顺序的关系，都必须能从 Contract、PluginDefinition 或显式参数中直接读出：

- Service 选择只由 `requires` 中的稳定 Contract ID 决定，不读取 Group、调用栈、当前 workspace 或祖先 Context；
- setup 顺序只由 Service 依赖图决定，不把安装顺序、Event、Extension 或完成时序当作隐藏依赖；
- 资源所有权来自创建它的 Lifetime，跨边界转交必须通过普通参数或 `Disposable` 明确表达；
- 领域配置通过插件配置、方法参数或显式适配器 Service 组合，不使用全局拦截链、Proxy shadow 或原型链覆盖。

“约定默认值”可以减少样板，但不能改变上述语义。若删除一段声明后运行时仍会从环境中猜出关系，说明抽象已经过度隐式。

## 二、能力代数

Core 只有四个能力原子和两个编排原子：

```text
能力原子
├── Service      稳定的一对一能力
├── Extension    动态的开放贡献集合
├── Event        不保留状态的事实
└── Lifetime     资源所有权与取消

编排原子
├── Plugin       一次 setup 的能力生产者
└── Application  依赖图、事务和实例编排
```

| 原子 | 保留当前值 | 动态变化 | 变化后的行为 |
| --- | ---: | ---: | --- |
| Service | 是 | 提供者拓扑可变化 | 重建消费者 |
| Extension | 是 | 贡献可实时增删 | 通知订阅者 |
| Event | 否 | 监听器可增删 | 广播本次事实 |
| Lifetime | 不适用 | 可创建子级 | 父释放全部存活子级 |

Signal 是能力内部的值类型，不是可由 `requires` 获取的新 Contract kind。

## 三、Contract

Core 的作者入口只有六个：

```ts
import {
  createApp,
  definePlugin,
  service,
  extension,
  event,
  optional,
} from "@dougong/core"
```

错误类是捕获边界，不属于能力原子预算。

声明：

```ts
const DATABASE = service<Database>("app/database")
const ROUTES = extension<Route>("http/routes")
const USER_CREATED = event<User>("users/created")
```

统一规则：

- 第一个参数是稳定字符串 ID，也是运行时唯一身份；对象身份不参与匹配。
- 返回值是冻结普通对象，形状只有 `{ id, kind }`。
- Contract 不持有运行时状态，可跨应用复用。
- ID 必须非空且首尾无空白；区分大小写，不做 trim 或 Unicode 规范化。
- 同一 ID 在一个 Application 中不能同时承担两种 kind，否则抛 `CONTRACT_CONFLICT`。
- 只有成功提交的声明和 active Lifetime 的运行期使用才登记 kind；失败的 setup、rollback 和未命中的宿主读取不会占用 Contract ID。
- `optional()` 只接受 Service；Extension 的空 Map 本身就是合法值，Event 没有提供者概念。

固定 Contract 的同一 ID 应在代码库中只声明一次并从稳定模块导出。TypeScript 无法阻止两个模块为同一 ID 写出不同类型参数。

同一种接口需要多份静态实例时，使用普通函数构造显式 Contract family，而不是引入隐式 Scope：

```ts
const workspaceStore = (workspace: string) =>
  service<Store>(`workspace/${encodeURIComponent(workspace)}/store`)

const ALPHA_STORE = workspaceStore("alpha")
const BETA_STORE = workspaceStore("beta")
```

family 函数本身是唯一声明源：类型和 ID namespace 只写一次，重复调用相同参数得到等价 ID，不依赖对象身份。提供者和消费者必须声明同一个具体 token。Contract ID 因而同时携带“能力是什么”和“选择哪一份”的稳定身份，依赖图、错误和诊断无需再解释第二张作用域树。动态且由每次请求选择的租户不应无限扩张插件图，应改为一个显式接收 tenant/workspace 参数的 Service。

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

Core 刻意不提供 `extension.keyed()`、`extension.many()`、`ordered()` 或 `override()`。这些是 Catalog、Pipeline 或具体领域的组合策略，不是贡献集合原子。

## 四、PluginDefinition

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

Service alias 得到稳定值；Extension alias 得到稳定的 `ExtensionView` 对象。Context 和 `ctx.meta` 浅冻结，但 Service 值本身不被代理或冻结。

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

缺少声明的输出抛 `SERVICE_NOT_RETURNED`。即使现成值来自宿主，也应包装成普通插件；Core 不提供 `app.provide()` 分支。

### 4.3 配置

配置接受 Standard Schema，并区分输入与输出：

```ts
StandardSchemaV1<ConfigInput, Config>
```

- `install(plugin, input)` 接收 `ConfigInput`。
- `setup(ctx, config)` 接收校验或转换后的 `Config`。
- Schema 可以异步校验。
- 配置失败抛含冻结 `issues` 的 `ConfigValidationError`。
- Core 不克隆或深冻结配置；防御性转换属于 Schema。

`definePlugin()` 在定义期校验结构；ChangeSet 在安装与更新边界重新规范化，防止 JavaScript 调用方绕过工厂。

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
ctx.contribute(extension, localKey, value)
```

`ctx.signal` 是标准 AbortSignal。`ctx.meta`：

```ts
{
  applicationName: string
  pluginName: string
  installationId: string
  groupId: string
}
```

文件系统、网络、窗口、剪贴板、存储、通知和路由器都应声明为 Service，不得成为 Context namespace。

Context 不提供 `effect()`、`observe()` 或 `using()`：

- `using(ctx, resource)` 可以机械展开为 `ctx.cleanup(() => dispose(resource))`。
- reactive `observe(ctx, source, listener)` 可以由 `get/subscribe + lifetime/spawn/cleanup` 完整实现。
- 两者位于更高层，Core 不需要私有特权。

## 六、Service

Service 是插件实例期内的稳定快照：

```ts
const db = ctx.db
db === ctx.db // 该实例存活期间恒为 true
```

禁止 live Service Proxy。提供者更新时，Application：

```text
预校验候选图与配置
→ 逆序停止受影响消费者
→ 停止旧提供者
→ 启动新提供者
→ 按依赖顺序重建消费者
```

`optional(SERVICE)` 也遵循快照语义。提供者从不存在变为存在或反向变化时，消费者实例会重建，不会修改活着的 Context。

Application 外部和测试边界可以读取：

```ts
const users = app.get(USERS)
```

`app.get()` 只接受 Service，并只在 Application 为 active 且该 Service 正在运行时成功；插件内部仍只能使用声明依赖。

Application 缓存当前 active runtime 对应的已验证依赖图；`app.get()` 只做 provider 与 Service Map 查询，不重新构图。idle 状态允许分步安装暂时不完整的计划，因此只在 `start()` 或 Application active 时提交的 ChangeSet 中构造候选图。

Application active 时执行 ChangeSet 会明确进入 `changing`，宿主 `app.get()` 暂时拒绝读取；它不会在停旧运行时、启新运行时的窗口中伪装成稳定的 active。事务成功或 rollback 完成后才重新进入 `active` 并切换对应图；无法恢复则 fail closed 到 `idle`。因此宿主读取边界只存在“提交前”和“提交后”，候选图或半重建的 Service Map 都不会泄漏。

### 6.1 启动调度

依赖图使用确定性的拓扑层：同一层没有 Service 依赖关系，可以并发 setup；下一层必须等待上一层完整提交。每层分为两个阶段：

```text
prepare: 并发创建 Lifetime、解析依赖、执行 setup、校验 Service 输出
commit:  整层成功后按稳定安装序发布 Service / Listener / Contribution
```

任一 setup 失败会 abort 同层其余 setup 的 `ctx.signal`，等待所有同层 setup 落定，并释放所有已 prepare 的 Lifetime。失败层公开零项新能力；已经提交的前置层由外层启动或 ChangeSet 回滚边界统一清理。

并发只来自显式 Service 依赖图。Event 和 Extension 不建立启动边，独立插件的 setup 先后与完成顺序未定义；需要顺序就声明一个 Service 依赖，不能依赖安装顺序或定时。停止仍按完整依赖图逆序串行执行，以保持确定的资源撤销顺序。

Core 当前不提供并发上限配置。它没有第二种调度模式，也没有在缺少数据时预设进程级策略；需要限制某类昂贵操作时，由相应 Service 自己提供队列或 semaphore，因为它才知道资源类型和真实容量。

## 七、Extension

### 7.1 原子模型

所有 Extension 都是：

> 由插件实例拥有、以稳定局部 key 标识的动态贡献 Map。

```ts
const ROUTES = extension<Route>("http/routes")

const contribution = ctx.contribute(ROUTES, "users.show", route)
contribution.update(nextRoute)
contribution.dispose()
```

真实 key 由运行时组合：

```text
<escaped plugin installation id>/<escaped local key>
```

其中 `%` 与 `/` 分别转义为 `%25` 与 `%2F`，因此分隔符不会让两组不同的 installation ID / 局部 key 组合产生同一个真实 key，同时常见 key 仍保持可读。

因此：

- 不同插件使用相同局部 key 不冲突；
- 同一 installation、同一局部 key 只能有一个存活贡献；
- 更新必须通过原 Contribution Handle；
- `undefined` 是合法贡献值，存活性由真实 key 与记录身份决定，不用值充当终态哨兵；
- 旧 Handle 使用记录身份校验，不能删除后来创建的同 key 贡献；
- 插件停止自动删除全部贡献；
- setup 失败不会发布贡献。

### 7.2 统一观察协议

```ts
interface ExtensionView<T> {
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

从 Context 获得的 ExtensionView 会把订阅自动归当前 Lifetime 所有；提前释放仍使用返回值的 `dispose()`。

快照是真正只读的 Map，没有 `set/delete/clear`。无变化时保持对象身份；提交变化时创建新快照。一次 Core ChangeSet 内同一 Extension 无论改变多少次，只通知一次。

ExtensionView 是插件 Lifetime 拥有的 live capability，而不是可永久泄漏的 Store 引用。插件停止后，旧 View 的 `get/subscribe` 会拒绝使用并切断对 Store 的引用；新实例会获得新 View。View 的公开 `get/subscribe` 由只持有可撤销 binding 的窄 Handle 提供，不能用在 Store 方法作用域中创建的箭头函数暗中捕获 Store。这个边界与旧 Service 闭包的处理不同：Service 是一次解析出的普通值，ExtensionView 则会持续观察运行时。

后续订阅者抛错进入 Application `onError`，不能破坏产生通知的运行时命令；首次读取与插件自己的同步 `rebuild()` 错误仍正常使 setup 失败。

### 7.3 高层组合

领域唯一性、排序、覆盖和折叠必须基于原始贡献组合：

```text
Extension<Command> + keyOf(command.id) + conflict policy → CommandCatalog Service
Extension<Middleware> + orderBy(order) + reduceRight    → Middleware Pipeline
Extension<Theme> + keyOf(theme.id) + stack policy       → ThemeCatalog Service
```

这些组合器可以提供更适合领域的 API，但其输入必须是公开 ExtensionView，生命周期必须使用公开 cleanup/subscribe，不能访问内部 ExtensionStore。

## 八、Event

```ts
const TRACK_CHANGED = event<Track>("playback/track-changed")

const subscription = ctx.on(TRACK_CHANGED, listener)
await ctx.emit(TRACK_CHANGED, track)
subscription.dispose()
```

Event 只有一种派发语义：

- 单 payload；复杂参数使用对象；
- 异步并发广播全部监听器；
- 等待全部完成；
- 不返回业务结果；
- 任意监听器失败时抛 `AggregateError`，即使只有一个原因；
- 监听器自动归创建它的 Lifetime 所有；
- setup 期间注册的监听器在 setup 成功前不可见。

如果需要结果，使用 Service；如果需要有序处理链，使用 Extension + 普通函数；如果需要当前状态，使用 Service 暴露 Readable/Signal。

Event 是事实而不是状态，因此一次 `emit()` 本身不可回滚。setup 中产生的外部副作用也应由插件负责补偿；Core 的事务承诺针对框架可见的 Service、Contribution 和 Listener。

## 九、Lifetime 与 Disposable

每个插件实例天然拥有一个根 Lifetime。所有通过 Context 创建的监听、贡献、订阅、任务、子 Lifetime 和 cleanup 都自动归它所有。

统一资源协议：

```ts
interface Disposable {
  dispose(): void | Promise<void>
  [Symbol.dispose]?(): void
  [Symbol.asyncDispose]?(): Promise<void>
}
```

资源句柄统一叫 `dispose()`；插件安装句柄从计划中删除统一叫 `remove()`。两者不能混用。

`dispose()` 是资源释放的 canonical API；`Symbol.dispose` / `Symbol.asyncDispose` 只是同一操作对 JavaScript `using` 语法的协议投影，不拥有第二套状态机或错误语义。

### 9.1 cleanup

```ts
const handle = ctx.cleanup(() => server.close())
await handle.dispose() // 可提前释放，幂等
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
- `label` 是必填、非空且首尾无空白的诊断描述，不参与运行时查找或身份判定；同级重名合法。
- 主动释放 Lifetime 或 Task 会用冻结的 `AbortError` 取消其 signal；父级取消仍显式转发父 signal 的 reason。调用方按 `signal.aborted` 与 reason 类型分类，不依赖 reason 对象身份。
- 释放进行中的重复 `dispose()` 共享同一个完成 Promise；进入终态后的重复调用只是已完成的无操作。发起释放的调用方仍收到原始失败，但终态 Handle 不继续保存已拒绝 Promise 或错误栈。Lifetime 完成释放后以一个新的、同 reason 的 aborted signal 表达终态，从而切断旧 signal 上的监听器闭包。

### 9.3 spawn

```ts
const task = ctx.spawn(signal => synchronize({ signal }))
await task.result
await task.dispose()
```

释放任务先 abort，再等待结果 settle。未被调用方同步处理的后台失败通过 Application `onError` 上报；Abort 后的失败视为取消结果，不重复上报。

任务自然 settle 后会立即从父 Lifetime 的拥有集合和 AbortSignal 监听器中脱离；之后调用该 Task 的 `dispose()` 只是幂等完成，不会追溯性 abort 已结束任务的 signal。已完成任务不会在长生命周期中按历史次数累积；父释放仍会 abort 并等待当时尚未 settle 的全部任务。

### 9.4 停止顺序

插件停止时顺序固定，不依赖注册巧合：

```text
拒绝新 Context 工作
→ 撤销 Service
→ 撤销 Listener、Contribution 与 Extension 订阅
→ abort 根 signal
→ 等待后台任务
→ 逆序释放子 Lifetime
→ LIFO 执行 cleanup
```

因此 cleanup 中不能继续 `emit()` 或申请新资源；停止已经越过“接受新工作”边界。

## 十、Application 与 ChangeSet

```ts
const app = createApp({
  name: "desktop",
  logger,
  onError,
})
```

### 10.1 安装与启动

```ts
const database = app.install(databasePlugin, config)
app.install(usersPlugin)

await app.start()
await database.ready()
```

`install()` 同步返回稳定 Handle，并把单项 ChangeSet 排入 Application 命令队列。定义形状错误同步抛出；提交或启动错误由 `ready()` / `start()` 暴露。

`ready()` 的屏障位于整笔命令之后：候选图验证、运行实例切换和 Extension 批次发布全部结束后才 settle。调用方在 `await handle.ready()` 后立即读取 ExtensionView 时只能得到已提交快照，不需要额外等待一个 tick。

命令队列线性化 install、update、remove、start 和 stop。一次失败不会破坏后续命令排队能力。

Core 用唯一的 `SerialQueue` 表达这条语义，Platform 的变更与激活队列也复用同一原语：

```ts
const commands = new SerialQueue()
const result = commands.run(operation) // 调用方收到自己的值或错误
await commands.settled                 // 等待读取时已经排入的全部操作
```

`run()` 无论前一项成功还是失败都会继续执行下一项；内部 tail 只记录完成边界且永不 reject，单项原始结果只返回给对应调用方。它是宿主和高层编排器共享的命令串行协议，不拥有 Application、事务或错误分类状态。

### 10.2 PluginHandle

```ts
handle.status
handle.ready()
handle.update({ plugin })
handle.update({ config })
handle.update({ plugin, config })
handle.remove()
```

`update()` 同时覆盖配置更新和定义替换，参数必须至少包含 `plugin` 或 `config` 之一，不提供 `replace/reload/restart`。定义更新不能改变插件 name；Handle 和 installation ID 始终稳定。

Handle 进入 `removed` 后撤销对 Application 的控制引用并释放插件定义与配置。终态 `remove()` 幂等成功，`update()` 以 `PLUGIN_REMOVED` 拒绝；保留一个已删除 Handle 不会反向保活 Application。

安装在提交前失败时，已经等待 `ready()` 的调用方仍收到原始 `Error`；非 `Error` 的 reject reason 在进入稳定失败状态时明确分类为 `PLUGIN_UNAVAILABLE`。实例脱离 Application 后，Handle 只保留错误的 `name/message/code` 纯数据摘要，后续 `ready()` 在调用边界重建错误。JavaScript `Error` 的调用栈可能保留整个编排对象图，不能成为终态句柄的隐藏所有权边。仍属于活动 Application 的失败实例继续保留原始错误，供诊断和重试语义使用。Platform 的终态 ManagedPlugin 遵守相同规则。

### 10.3 canonical ChangeSet

```ts
const change = app.change()
change.update(provider, { plugin: providerV2 })
change.update(consumer, { plugin: consumerV2 })
change.remove(legacy)
const extra = change.install(extraPlugin)
await change.commit()
```

规则：

- one-shot；首次 `commit()` 后封口；
- commit 幂等，重复调用返回同一 Promise；
- 空 ChangeSet 是无副作用的已提交 no-op，不制造伪 `changing` 状态或诊断 revision；
- 同一 Handle 在一份 ChangeSet 中只能出现一次；
- 拒绝其他 Application 的 Handle；
- 候选依赖图和全部受影响配置在停止任何实例前完成校验；
- 执行期间 Application 为 `changing`，宿主 Service 读取关闭；
- active 变更只重建目标和新旧图中受影响的传递消费者；
- 多项变更共用一份停止、启动、回滚与 Extension 通知边界。

`change.install()` 返回的是该 ChangeSet 拥有的 draft Handle。调用 `commit()` 时它才获得 Application 控制权限；commit 前直接调用其 `update/remove` 会以 `PLUGIN_UNAVAILABLE` 拒绝，不能暗中排入第二份 ChangeSet。`app.install()` 之所以返回即可控制，是因为该语法糖在返回前已经同步提交了内部单项 ChangeSet。

变更 setup 失败时，Core 释放部分新运行时并恢复旧图。若旧资源无法停止、新运行时无法清理或旧图无法恢复，Application fail closed 到 idle，不谎报 active。

### 10.4 stop

`app.stop()` 按依赖逆序停止。停止后安装计划仍在，Handle 回到 pending；再次 `start()` 会按当前定义和配置重新创建实例。`remove()` 才会从计划删除。

## 十一、Group

Group 是安装组合和子树所有权，不是第七个内核原子，也不是依赖注入 Scope：

```ts
const backend = app.group("backend", group => {
  group.install(databasePlugin, config.database)
  group.install(usersPlugin)
  group.group("transport", transport => {
    transport.install(httpPlugin, config.http)
  })
})

await backend.ready()
await backend.remove()
```

Application 与 Group 使用同一组 `install/group/change` 动词。首次 configure 必须同步，以便所有声明编译进一份 ChangeSet；返回 thenable 会立即拒绝。

Group 的规则：

- 可嵌套；
- configure 内全部安装共享一次提交；
- `ready()` 等待 configure 产生的安装越过 ready barrier；
- `remove()` 用一次 Core 事务删除整棵子树；
- Group ChangeSet 只能修改自身子树的 Handle；
- GroupHandle 与 PluginHandle 共享 `status/ready/remove`，只有 PluginHandle 增加 `update`；
- Group 不改变能力可见性：Service、Extension 和 Event 都属于整个 Application。

嵌套 Group configure 共享同一个显式配置会话。任一子级失败都会把整份会话置为 `failed`，即使调用方在外层捕获了该异常，也不能继续向已经失败的草稿追加声明或提交部分配置。非 `Error` 的失败值在配置和运行事务边界统一分类为 `GROUP_UNAVAILABLE`；`ready()` 失败后 Group 状态必须是 `failed`，不能因为失败值恰好为 `undefined` 而呈现为健康。

每个 Group 只保留一份当前 readiness barrier。尚未成功建立的 Group 在提交失败后保持 `failed`，后续成功变更会替换旧 barrier 并建立 Group；已经建立的 Group 若变更失败且 Core 恢复了原提交状态，则继续保持健康。`status` 与 `ready()` 始终读取同一份生命周期状态。

删除 Group 会同时撤销整棵子树的 Handle 权限。终态 GroupHandle 只保留身份和 `removed` 状态，`remove()` 幂等；它不再持有 Application、配置会话或历史失败调用栈，也不能创建安装、子 Group 或 ChangeSet。

需要工作区或租户区分时，根据语义选择：固定且需要独立依赖图的少量实例使用显式 Contract family；运行期按请求选择的数据使用带 tenant/workspace 参数的 Service；完全独立的能力图使用多个 Application；安全隔离使用 Worker/iframe/进程。不要把 Group 冒充解析或安全边界。

## 十二、事务发布

单个拓扑层启动：

```text
1. 校验配置
2. 为层内每个插件解析稳定 Service 快照与 ExtensionView
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

Application start、stop 和 active 状态下提交的 ChangeSet 使用 Extension 批次：观察者只能看到操作前或操作后的快照，不看到逐插件半成品。

## 十三、统一观察协议与 reactive 层

ExtensionView、Application diagnostics、Platform diagnostics 和 `@dougong/reactive` Signal 统一采用结构协议：

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

`view` 是权限收窄，不是第二套观察 API：读取方只能 `get/subscribe`，拥有方只能通过 Publisher 驱动失效和终止。`dispose()` 会在切断 reader、reporter 与现有订阅前固化最后一份快照；历史 view 因而仍可读取终态，但不能反向保活运行时。Application、Lifetime 与 Platform diagnostics 都走这条路径，高层不得重写订阅注册表和错误边界。

快照需要 Map 语义时统一使用 `ReadonlyMapSnapshot`。它复制输入并只暴露 `ReadonlyMap` 方法，避免 `Object.freeze(new Map())` 仍可调用 `set/delete/clear` 的伪不可变性；它只保证容器结构不可变，条目值仍应在进入快照时自行冻结。

`@dougong/reactive` 是独立基础包：

```ts
signal(initial)
computed(calculate)
batch(callback)
observe(lifetimeOwner, source, observer)
```

- Signal 保存当前值；
- computed 自动追踪仅用于同步、纯、懒、缓存计算；
- batch 只接受同步 callback，并合并 callback 内的通知；
- observe 是更高层的 Lifetime 组合器：显式读取一个 source，为当前值创建子 Lifetime，变化时先释放旧子级再创建新子级；observer 必须同步，后续替换失败会停止观察并释放订阅与当前子 Lifetime。

```ts
const endpoint = computed(() => `${base.get()}/${account.get()}`)

observe(ctx, endpoint, (url, lifetime) => {
  const socket = new WebSocket(url)
  lifetime.cleanup(() => socket.close())
})
```

`observe()` 只使用公开 `get/subscribe/lifetime/spawn/cleanup`，因此不是 Core 特权或第二套运行时。Core 不依赖 reactive，第三方 Readable 也可结构兼容。

结构兼容只统一观察协议，不抹平资源来源的所有权边界：Context 注入的 ExtensionView 是绑定当前 Lifetime 的 live capability，直接 `subscribe()` 产生的订阅会自动归该 Lifetime 所有；独立 Signal 或第三方 Readable 没有隐含 owner，直接订阅时由调用方持有返回的 Disposable，或交给 `observe(owner, source, observer)` 组合进显式 Lifetime。两者仍只有同一个 `subscribe()` 和同一个 `dispose()`，差异只在是否已经存在明确的结构化 owner。

不提供 Solid 式裸 `effect()`、依赖数组、深层 Proxy Store、`watchEffect/autorun/reaction`。Effect-TS 可以在 Service 内使用或经单向适配器接入，不进入 Core。

## 十四、诊断与封装边界

```ts
app.diagnostics.get()
app.diagnostics.subscribe(notify)
```

快照包含 Application name/status/revision、PluginSnapshot Map 和 GroupSnapshot Map。快照、条目、数组与 Map 都只读；诊断不能控制运行时。

运行中的 `PluginSnapshot` 还包含一份独立的 `lifetime` 观察视图：

```ts
interface LifetimeSnapshot {
  readonly label: string
  readonly phase: "active" | "disposing" | "disposed"
  readonly cleanups: number
  readonly tasks: number
  readonly listeners: number
  readonly contributions: number
  readonly extensionViews: number
  readonly subscriptions: number
  readonly children: readonly LifetimeSnapshot[]
}

const lifetime = app.diagnostics.get().plugins.get(id)?.lifetime
const current = lifetime?.get()
const subscription = lifetime?.subscribe(render)
```

根节点的 `label` 是稳定的 installation ID；每个 `children` 条目严格对应一次真实的 `lifetime(label)` 所有权关系。节点计数只描述该 Lifetime 直接拥有的资源，`children` 只列直接子 Lifetime。子树总量可由这组不可再约简的事实递归推导，不在快照中保存第二份聚合状态。整棵快照递归冻结，但不暴露 Lifetime、资源对象、回调或 Store。

label 只回答“这组资源为何共同存活”，不是 capability ID、查找 key 或新的 Scope。重复 label 不产生冲突，也不改变释放语义。cleanup、task、listener 等叶资源不各自增加命名重载；只有确实存在共同释放边界时才创建子 Lifetime。Core 不从函数名、调用栈或序号猜测节点，也不为了实现分类计数伪造树层级。

资源变化只更新这份小型视图，不增加 Application revision，也不重建全部 PluginSnapshot；调用方要观察资源变化就显式订阅嵌套视图。子 Lifetime 终止后立即从树中摘除；插件停止后新的 PluginSnapshot 不再含 `lifetime`，已经取得的旧视图会停在无子节点、全零计数的 `disposed` 终态，且不再保留 Application。

公共 Handle 与顶层 Application / Platform 都是冻结窄对象。纯 JavaScript 检查自有属性或原型，也不会看到：

```text
PluginInstallation
GroupNode
ExtensionStore
EventHub
LifetimeHost
ChangeSet host
ChangeSet discard / Handle attach / revoke
Application 的 Group 编排端口
staged publication method
Platform Artifact / Core Handle
```

TypeScript 的 `private` 不被当作安全措施；实现使用真正的 `#private` 字段或独立 facade Handle，防止运行时形状泄露。

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
| `SERVICE_UNAVAILABLE` | 外部读取或运行时绑定当前不可用 |
| `PLUGIN_REMOVED` | 操作已从计划移除的实例 |
| `PLUGIN_UNAVAILABLE` | Handle 无法进入可等待状态 |
| `PLUGIN_IDENTITY` | update 试图改变插件 name |
| `GROUP_REMOVED` | 操作已移除的 Group |
| `GROUP_UNAVAILABLE` | Group 尚未成功建立 |

Event 因定义要求收集全部监听器失败，总是抛 AggregateError。Lifetime 与关停先尝试所有资源：一个失败原样抛出，多个失败聚合。rollback/fail-closed 跨多个阶段时统一使用 AggregateError。

后台任务、订阅者和后续 observe 的错误无法回到原同步调用栈，通过 `onError` 上报。`onError` 自身失败也不得改变正在观察的运行时命令。

## 十六、禁止方向

- 插件基类和框架继承树；
- 装饰器依赖注入与字符串 Service Locator；
- Proxy Context、原型链 shadow、live Service Proxy；
- Core 内置 Signal/effect、React、HTTP、Node、文件系统或定时器；
- `extension.keyed/many/ordered/override` 等领域策略进入 Core；
- Scope 与 Group 混为一谈；
- lifecycle hook 矩阵；
- Event 增加 serial/bail/waterfall 等查询模式；
- 插件任意修改全局插件图；
- Loader、Manifest、HMR 或权限进入 Core；
- 用 Context API 限制冒充安全沙箱；
- 只在类型声明隐藏、但在 JavaScript 对象上泄露内部字段或方法。

## 十七、最终判据

任何新需求先回答：

1. 它是稳定能力、开放贡献、瞬时事实还是资源？
2. 能否由 Service、Extension、Event、Lifetime 和普通函数组合？
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
    live extension views,
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
Service 变化重建消费者，Extension 变化通知订阅者，Event 只广播本次事实。
```
