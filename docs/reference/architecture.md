# Dougong 架构说明

本文解释 Dougong 为什么采用当前分层，以及能力如何向前端、后端和桌面插件系统组合。精确 API 行为见 [Core API 规范](./core-api.md)；面向使用者的渐进式介绍见[核心概念](../guide/concepts.md)。

## 一、定位

Dougong Core 是“能力组合与结构化生命周期内核”，不是大一统框架。

它要解决的共同问题是：

```text
能力从哪里来
→ 哪些实例依赖它
→ 开放贡献如何动态变化
→ 事实如何广播
→ 资源属于谁、何时释放
→ 多项变更如何原子提交与恢复
```

它刻意不解决具体领域：HTTP、React、命令面板、音乐 Provider、文件系统、窗口和 Agent tool 都是上层 vocabulary。

## 二、分层

```text
                         examples
                            │
                            ▼
                         dougong facade
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
              platform      core     reactive
                  │
                  └──────────► core

core 与 reactive 互不依赖
```

### `@dougongjs/core`

只依赖标准 JavaScript 与 Standard Schema 类型契约，负责：

- Service / Extension / Event Contract；
- PluginDefinition 与冻结 Context；
- Service 依赖图和稳定快照；
- Lifetime、AbortSignal、任务和资源释放；
- ChangeSet、增量重建、rollback 与 fail-closed；
- Group 所有权树；
- 跨层共用、失败不污染后续命令的 SerialQueue；
- 只读诊断投影。

Core 内部也保持同一分工：Application 只拥有声明注册表、`SerialQueue` 和状态发布；GroupCoordinator 只拥有结构 Group；ApplicationRuntime 只拥有已经提交的 Contract、Service、Event、Extension、Lifetime 与运行图。Platform 直接复用 Core 的同一串行原语，不复制失败隔离状态机。事务由 Application 发起，但运行图的切换、rollback 与 fail-closed 只在 ApplicationRuntime 中执行，因此声明状态和实例状态各有一个真相源，而不是把全部职责堆进一个总类。

### `@dougongjs/reactive`

零依赖值层，负责：

- `signal()`：当前值；
- `computed()`：纯计算派生；
- `batch()`：合并失效通知；
- `observe()`：用公开 Lifetime 协议把当前值同步到外部资源。

Core 不导入 reactive。二者通过结构化 `get()/subscribe()` 和 Lifetime 对象协议组合，因此第三方 Observable 也能接入。

`Disposable` 等极小协议会在两个基础包中分别声明。它们没有运行时对象或实现，TypeScript 依靠结构类型互通。这是有意的协议声明重复，用来换取双向零依赖；单路径原则禁止的是重复状态机和运行时语义，不是要求独立基础包共享一个类型来源。

### `@dougongjs/platform`

外部插件分发层，负责：

- Manifest 与版本约束；
- Loader 与模块边界；
- 权限决策端口；
- lazy activation 与占位插件；
- Manifest 依赖；
- HMR / Artifact 更新；
- Platform ChangeSet。

Platform 把结果编译成普通 Core PluginDefinition 和一份 Core ChangeSet，不复制运行时。

### `dougong`

纯 re-export 便利入口，没有逻辑、状态或第二条路径。严格分层的库作者仍可直接依赖细包。

### `@dougongjs/examples`

最外层的可执行学习与宿主参考包，只依赖公开 `dougong` facade。十二章分三段递进：原子（Service、Extension/Event、Lifetime、Signal）、组合（配置与失败、Contract family 与 Group、诊断、Platform）、真实宿主（Planet、Lynx、声明式计划、模块图 HMR）。

递进关系本身是受测的：每章声明自己首次引入的概念，测试把十二章的声明首尾相接，与 `example.ts` 中的教学大纲做全等比较——概念重复、顺序倒置或某章无新增都会失败。

宿主策略先在这里接受真实使用与回归测试；只有多个宿主复用出稳定边界后才提炼成独立包。任何基础包都禁止反向依赖 examples；示例若必须访问内部模块，说明公共组合能力尚未闭合。

## 三、为什么是四种能力

能力变化的四种基本时间语义彼此不同：

| 问题 | 原子 | 关键保证 |
| --- | --- | --- |
| “谁能为我完成这个操作？” | Service | 一个提供者、实例期稳定 |
| “目前有哪些开放贡献？” | Extension | Map 快照、动态增删 |
| “刚刚发生了什么？” | Event | 不保留、并发广播 |
| “这组资源活到什么时候？” | Lifetime | 结构化取消和释放 |

把它们合并会产生坏味道：

- Event 若返回业务结果，会同时变成命令、查询和 middleware；
- Service 若动态替换对象而不重建消费者，闭包会持有不可预测引用；
- Extension 若内置 key selector、order 和 override，就把 Command/Theme/HTTP 的策略泄露进 Core；
- Lifetime 若解析依赖，就会变成隐藏 Scope 或 IoC 容器。

四者分离后，Plugin 只负责生产，Application 只负责编排。

## 四、组合优于继承的可验证含义

Dougong 不把“不写 class”误认为组合。判断标准有四个。

### 4.1 高级功能没有内核特权

官方与第三方实现必须使用同一公开 API。以下能力都不需要修改 Core：

- HTTP Route 与 middleware pipeline；
- 命令、快捷键、菜单和命令面板；
- UI Slot、Panel、Theme、Renderer；
- 音乐 Provider 与播放策略；
- Agent Tool、模型 Provider 与事件 fold；
- Scheduler、后台作业、日志 sink、指标；
- Loader、HMR、DevTools 和测试工具。

若官方 Catalog 需要直接读 `ExtensionStore`，说明抽象还未闭合。

### 4.2 高层能力机械展开

```text
commands.register(command)
  = ctx.contribute(COMMANDS, command.id, command)

using(ctx, resource)
  = ctx.cleanup(() => dispose(resource))

observe(ctx, source, callback)
  = source.get + source.subscribe
  + ctx.lifetime + ctx.spawn + ctx.cleanup

platform.reload(artifact)
  = coreHandle.update({ plugin, config })
```

高层可以增加 Schema、默认值、策略和领域错误，但不能绕过所有权、事务或权限。

### 4.3 Handle 同构

- 安装计划中的实体：`status / ready / remove`；Plugin 额外 `update`。
- 可提前释放的资源：统一 `dispose`。
- 可观察值：统一 `get / subscribe`。
- Application 与 Group：统一 `install / group / change`。

跨层 API 的差异来自职责，不来自随意命名。

### 4.4 显式关系是组合的前提

组合只有在边界可见时才比继承更容易推理。Dougong 不从 Group、祖先 Context、调用栈或全局“当前值”猜测 Service 提供者，也不从安装顺序猜测 setup 顺序。能力选择写进 Contract ID，依赖写进 `requires`，所有权写进 Lifetime，运行期选择写进普通方法参数。

这也约束高层语法糖：它可以生成 token、PluginDefinition 或 ChangeSet，但展开结果必须完整表达关系，不能把一部分语义藏在另一张 scope/shadow/interceptor 图里。

## 五、Service 图与普通闭包

Service 不使用 live Proxy：

```text
provider A ──► consumer B ──► consumer C
```

更新 A 时，Application 计算新旧图的影响闭包，按 `C → B → A` 停止，再按 `A → B → C` 启动。未受影响插件不重启。

Application 只缓存当前 active runtime 对应的已验证图。`app.get()` 在该图上做常数级 Map 查询；候选图只在 `start()` 或 ChangeSet 校验时构建，并在事务完全成功后替换缓存。idle 安装计划可以暂时缺少依赖，从而不破坏“先声明多个安装、最后统一 start”的使用方式。

Application active 时提交 ChangeSet，其停止与重建窗口是显式的 `changing` 状态，不是假 active。此时宿主 Service 读取关闭；成功提交或完整 rollback 后才恢复 `active`，从而避免同一读取边界混合旧图与新 runtime。

这样插件可以放心使用普通闭包：

```ts
setup(ctx) {
  const database = ctx.database
  return createUsers(database)
}
```

它不需要 Signal、Proxy 或“依赖是否已经变了”的防御逻辑。稳定 Service 是低心智负担的重要来源。

依赖图同时给出不可变拓扑层。Application 对一层执行并发 prepare，等所有 setup 与 Service 输出校验成功后，再按稳定安装序统一 commit；下一层只能读取已经提交的前置 Service。任一同层插件失败会取消同层其余 setup，并释放整层所有未公开 Lifetime。

```text
layer 0  [database, cache, logger]  ── concurrent prepare ── commit
layer 1  [users, search]            ── concurrent prepare ── commit
layer 2  [http]                     ── prepare ───────────── commit
```

这不是“尽量猜测哪些插件可以并发”：唯一依据仍是显式 Service 边。Event 和 Extension 不形成启动依赖；独立 setup 的先后顺序未定义。需要顺序的插件必须声明 Service，不得依赖安装先后或微任务时序。停止保持依赖逆序串行，因为资源撤销顺序是可观察语义，而不是启动吞吐瓶颈的镜像问题。

## 六、Extension 为什么保持原始

Core Extension 的信息保真度最高：所有贡献都保留，真实 key 带实例前缀。它不提前丢弃同领域 key 的旧值，也不强加顺序。

因此不同领域能独立选择策略：

```text
raw contributions
├── group by command.id + reject duplicate  → CommandCatalog
├── group by theme.id + last wins stack     → ThemeCatalog
├── sort by order + reduceRight             → MiddlewarePipeline
├── filter by slot                          → UI Slot
└── score + select                          → ProviderSelector
```

如果 Core 只暴露“当前 winner”，卸载后恢复旧 Theme 所需的信息已经丢失；如果 Core 直接规定 last-wins，命令系统希望 reject 时又需要旁路。保留原始集合，策略才能真正组合。

ExtensionView 与 Signal 共享结构协议，但不是 Signal 节点。`computed()` 只追踪 Dougong Signal，避免一个看似纯的计算暗中订阅任意外部 Store。需要跨层同步时，使用显式 subscribe 或 reactive `observe()`。

## 七、Lifetime 是组合地基

每个插件实例拥有根 Lifetime，并形成资源树：

```text
Plugin Lifetime
├── Event subscription
├── Extension contribution
├── ExtensionView subscription
├── background task
├── child Lifetime ("session")
│   ├── task
│   └── cleanup
└── cleanup stack
```

这不是 Hook 或响应式 Effect，只是所有权。子级通过唯一入口 `lifetime(label)` 创建；label 描述这组资源共同存活的原因，不参与依赖解析、运行时查找或身份判定。

顺序被明确编码为对象状态机：先撤销公开能力，再取消任务和子级，最后执行用户 cleanup。内部不依赖“恰好按某种注册顺序 reverse”来获得正确语义。

子 Lifetime 提前 dispose 后会从父拥有集合脱离。后台 Task 自然 settle 后也会从父任务集合和父 AbortSignal 监听器中脱离；父释放只取消并等待仍在运行的任务。两者都避免长生命周期按历史创建次数积累已完成对象。

同一规则覆盖全部内部 lease：Listener、Contribution、ExtensionView 及其订阅、cleanup 和 Task 在提前终止时都会从父集合摘除；终态对象同时清空 owner、Store、回调、payload 和诊断记账引用。七个资源类别复用同一套活跃资源集合实现，从而获得 O(1) 摘除、幂等 ownership release 与诊断增减。各类别仍使用独立集合表达发布顺序、释放顺序和分类计数，统一机制不混合语义。

主动释放 Lifetime 或 Task 使用模块级冻结 `AbortError` 作为取消原因，父取消则原样转发父 reason。这里共享的只是无状态错误值，不是 ambient scope；它避免每次 `abort()` 自动创建的错误调用栈把终态 `AbortSignal.reason` 变成一条指回 Application 的隐藏保留边。释放完成后，Lifetime 用一个新的同 reason aborted signal 替换运行期 signal；终态 Handle 因而不会继续保留旧 signal 的监听器闭包。进行中的释放 Promise 只属于 `disposing` 状态，进入 `disposed` 后同样被结构性丢弃，原始失败仍由已取得该 Promise 的调用方观察。

父级只拥有仍然存活的资源，保留一个已释放 Handle 不会反向保活整个 Application。ExtensionView 使用显式窄 Handle，而不是从 Store 实例方法返回捕获词法 `this` 的箭头函数；清空 binding 后，公开 View 本身也不能成为 Store 的隐藏所有权边。

相同约束也适用于安装所有权：终态 PluginInstallation 只保留不可变 group ID，已分离 Group 清空 parent、事务屏障与历史 failure。历史 Handle 因而不能经由所有权树或错误调用栈保活兄弟 Group 或 Application 根节点。

终态摘除也覆盖错误对象。V8 的 `Error.stack` 可能携带创建错误时的编排调用帧，因此已脱离 Core 或 Platform 的失败 Handle 只保存 `name/message/code` 摘要，并在调用方再次读取失败时重建错误；正在等待提交的调用方仍接收原始错误。错误没有被静默丢弃，调用栈也不会成为一条不可见的宿主所有权边。

ExtensionRegistry 也只保留仍有 claim、View 或 subscription 的 Store；最后一个所有者释放后，空 Store 会从注册表摘除。失败 setup 即使尝试过从未提交的 Extension ID，也不会让 Application 按历史失败次数积累空 Store。

ExtensionView 订阅包含两条正交的内部所有权边：Lifetime 拥有 subscription handle，ExtensionStore 拥有 listener 注册。一次公开 `dispose()` 必须同时切断两者；前者保证父 Lifetime 不积累终态 Handle，后者保证 Store 不继续通知或保活已退订的回调。这只是同一 Disposable 操作的内部原子释放，不形成第二套公开 API。

每个根 Lifetime 还维护一份只读诊断视图。它逐节点投影真实的 Lifetime 所有权关系：根 label 是 installation ID，子节点 label 来自 `lifetime(label)`；每个节点按 cleanup、task、listener、contribution、ExtensionView 和 subscription 分类报告自己直接拥有的资源。子树总量可递归推导，不重复保存在节点中。诊断树不保存叶资源，也不从调用栈或函数名猜测伪节点。只有真实的共同释放边界才能形成节点，因此诊断结构与运行语义始终一致。

这份视图复用 `get/subscribe` 协议，并与 Application 结构快照分离：高频资源变化不会重建整张插件图，DevTools 又能回答“哪组资源当前持有什么”。子 Lifetime 终止即从父节点摘除；根终态视图只保留无子节点、全零计数的快照，不反向保活 Application 或资源对象。

## 八、事务模型

Core 区分三类事务边界：

### 插件 setup

Contract kind、Listener 和 Contribution 都先进入事务草稿。Service 输出与整笔运行切换全部成功后，Contract kind 才进入 Application 注册表；Listener 和 Contribution 则随所属拓扑层的 Lifetime 发布。失败 setup 与 rollback 会丢弃草稿，同时切断草稿对注册表 authority 的引用，既不能留下幽灵 Contract 身份，也不能让终态草稿反向保活注册表。公共 Handle 只暴露 `dispose/update`，不暴露内部 `publish()`，因此 JavaScript 插件也无法提前越过提交点。

### Extension 通知

Application start、stop 和 ChangeSet 使用批次。内部 Map 可以经历停止与重建，但 View 的公开快照只在事务结束时切换一次。

Application active 时提交的 ChangeSet 先产生 committed 或 rolled-back outcome，Extension 批次完成发布后才 settle 对应 Plugin Handle。`ready()` 因而是事务屏障，不会早于最终 Extension 快照。

### 多插件图变更

ChangeSet 先构造和验证完整候选图，再触碰当前 runtime。进入执行窗口后 Application 为 `changing`，`app.get()` 不观察逐实例停止与启动；成功或 rollback 完成后才恢复 active。任何清理不完整都会 fail closed，而不是留下“看起来 active”的混合状态。

动态 import 的模块顶层副作用、网络请求或操作系统资源本身无法由内存事务回滚。这些属于 Loader/插件的补偿责任，文档不能把框架事务包装成分布式事务承诺。

## 九、Group 为什么不是 Scope

Group 解决：

- 一组安装如何共享一次提交；
- 如何嵌套组织；
- 如何等待一组实例 ready；
- 如何原子删除整棵安装子树。

Group 配置、结构所有权、运行状态与 Handle 权限各自使用封闭状态机。配置会话是 `open / failed / sealed`，结构节点是 `attached / detached`，生命周期保存 established 状态与当前 readiness barrier，Handle 是 `configuring / attached / revoked`。

这些状态机由一个内部 `GroupCoordinator` 组合，不再散落在 Application 编排器中。Coordinator 完整拥有 Group 树、Handle authority 与 readiness；Application 只通过窄端口提供插件 ChangeSet、串行命令和诊断发布。这个边界不会新增公共概念，也不会让 Group 获得能力解析权。

嵌套 configure 共享一份配置会话；第一次失败会毒化整笔草稿，外层即使捕获异常也不能继续声明或提交。任意非 `Error` 失败在边界分类后再进入生命周期，因此 `undefined` 永远不同时承担“失败值”和“没有失败”两种含义。已建立 Group 的失败变更若完整回滚，就继续呈现已提交状态；未建立 Group 可由后续成功变更替换失败 barrier。

它不解决“谁能看见什么能力”。Service、Extension 和 Event 在同一个 Application 内全局一致。

把能力 Scope 塞进 Group 会带来三套新规则：祖先继承、局部遮蔽、事件冒泡/隔离；随后 Loader、诊断和事务都必须理解空间图。这不是四个能力原子自然推出的结果，而且很容易被误解为安全隔离。

真正需要隔离时选择明确边界：

| 需求 | 建议 |
| --- | --- |
| 仅批量安装/卸载 | Group |
| 少量固定工作区各有一份同型能力 | 显式 Contract family |
| 请求期动态选择工作区数据 | Service API 显式带 workspace ID |
| 独立能力图 | 多个 Application |
| 不可信代码 | Worker / iframe / 进程 / 受限 Realm |
| 远程能力 | RPC Service Proxy |

这样“组织”和“隔离”不会在一个模糊抽象中互相泄露。

Contract family 只是现有 `service()` 的普通函数组合，不是第五种 Contract：

```ts
const workspaceStore = (workspace: string) =>
  service<Store>(`workspace/${encodeURIComponent(workspace)}/store`)

const ALPHA_STORE = workspaceStore("alpha")

const alphaStorePlugin = definePlugin({
  name: "workspace.alpha.store",
  provides: { store: ALPHA_STORE },
  setup: () => ({ store: createStore("alpha") }),
})

const alphaSearchPlugin = definePlugin({
  name: "workspace.alpha.search",
  requires: { store: ALPHA_STORE },
  setup: ctx => createSearch(ctx.store),
})
```

同一接口可以有多个提供者，但每个提供者属于不同的显式 ID，冲突、缺失、依赖闭包和诊断仍由同一张 PluginGraph 处理。若要给某一份 Service 叠加配置，使用一个显式 adapter plugin：它 requires 基础 token、provides 新 token，并用该 Service 自己理解的类型构造包装值。Core 不提供无法类型检查的通用 `intercept()` 或 Proxy shadow 链。

## 十、Signal 与副作用边界

Signal 值得存在，但自动追踪只进入纯 computed：

```text
signal   当前值
computed 值如何纯推导
observe  值变化后如何重建一组资源
Lifetime 这组同步何时结束
```

`computed()` 和 `batch()` 都拒绝 thenable 结果，避免把同步追踪或批次边界错误地延伸到 `await` 之后。`observe()` 创建一项长期受 owner 管理的 drain task；通知只唤醒它，替换失败则通过 task 结果上报并停止观察。

`observe()` 放在 reactive 层而不是 Context：

1. 它能完全用公开协议实现，Core 不需要特权；
2. 不使用 Signal 的后端无需承担响应式概念；
3. Context API 预算不膨胀；
4. 第三方 Readable 结构兼容；
5. 自动追踪不会控制插件 setup 或资源边界。

Effect-TS 与 Core 在 DI、Scope、Fiber 和错误运行时上高度重叠，因此只允许单向适配，不进入基础模型。

## 十一、Platform 与安全边界

同 Realm JavaScript 永远可以访问全局环境。Manifest permissions 表达宿主政策，不构成沙箱。

```text
可信插件      同 Realm ESM，可贡献函数和 UI 组件
半可信插件    同 Realm + admission/activation 权限审核
不可信插件    Worker / iframe / 独立进程
跨 Realm      序列化消息或 RPC Service
不可信 UI     声明式数据，由宿主渲染
```

Platform 的 Loader 可以返回宿主编写的 RPC PluginDefinition。Core 只看到普通 Service 与 Lifetime，不需要认识传输协议。

## 十二、真实项目映射

### Planet

| 需求 | Dougong 组合 |
| --- | --- |
| 播放器 / 数据库 | Service |
| 音乐来源 | Extension 原始贡献 + ProviderSelector |
| 曲目变化 | Event 或 Store Service |
| 音频连接 | Lifetime + spawn + cleanup |
| Provider 热插拔 | Platform activation + Core update/remove |

动态 Provider 贡献变化不会重启播放器；播放器订阅 ExtensionView 并更新自己的选择器。

### Lynx Desktop

| 需求 | Dougong 组合 |
| --- | --- |
| 命令、菜单、面板、renderer | Extension |
| 唯一命令与覆盖主题 | 领域 Catalog Service |
| 文件系统、窗口、存储 | 宿主 Service |
| 一组工作区插件 | Group |
| sideload / lazy / HMR | Platform |
| React 实时展示 | `useSyncExternalStore` 薄适配 |
| 不可信扩展 | Worker/iframe + RPC Service |

Group 删除负责安装所有权；领域值中的 workspace ID 负责数据选择。二者职责清楚，不依赖隐式 Scope。

## 十三、依赖方向门禁

`scripts/check-layers.mjs` 把以下规则变成 CI 失败：

- core 与 reactive 互不导入；
- platform 不被 core/reactive 反向依赖；
- facade 只能 re-export；
- examples 只能作为最外层消费者，其他包不得反向依赖；
- Core/Platform 内部模块只能向更低 rank 导入；
- Core/Platform 源码不导入 Node built-in；
- runtime 不读取隐藏 clock/entropy；
- 诊断不直接调用 console；
- Lifetime 只能由 ApplicationRuntime 和 Lifetime 自身构造；
- 无循环依赖。

架构约束如果只存在于文字里，几个月后就会退化成建议；Dougong 把可以机械判断的部分交给工具。

## 十四、长期判断标准

新增抽象前逐项检查：

1. 是否能由现有四种能力表达？
2. 是否只是某个领域的 key/order/conflict 策略？
3. 是否与已有 API 形成同层近义词？
4. 是否需要 Core 私有状态，还是公开协议已经足够？
5. 是否改变生命周期、事务或错误模型？
6. 是否在类型之外泄露内部对象？
7. 是否把组织、权限或便利误称为安全隔离？
8. 删除具体框架和宿主后，这个抽象是否仍成立？

Dougong 的目标不是“功能最多的 Core”，而是“最小且闭合的 Core”：原子足够少，组合表达力足够大，任何高级能力都不需要逃逸到底层。
