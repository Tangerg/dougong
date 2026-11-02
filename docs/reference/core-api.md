# Core API 参考

主包 `dougong` 是实际内核；默认导出面只有一个明确的运行模型。本页记录公开协议；边界、取舍与禁止事项的理由见[架构与设计理由](./architecture.md)，执行与故障处置见[计划与执行](../guide/transactions.md)。

## 公开导出

| 责任 | 导出 |
| --- | --- |
| 契约 / Contracts | `service`, `extensionPoint`, `event`, `optional`, `ContractKind`, `ContractValue`, `Service`, `ExtensionPoint`, `Event`, `OptionalService`, `Requirement` |
| 插件 / Plugins | `definePlugin`, `describePlugin`, `PluginDescriptor`, `PluginConfigurationDescriptor`, `PluginDescriptionOptions`, `Plugin`, `AnyPlugin`, `PluginContext`, `Requirements`, `Provisions`, `ResolvedRequirement`, `ResolvedRequirements`, `ProvidedServices`, `InstanceMetadata` |
| 安装与计划 / Installation and planning | `ChangeSet`, `Group`, `Installation`, `InstallationOptions`, `InstallationUpdate`, `InstallationOrigin`, `InitialInstallation`, `Plan`, `PlanReport`, `BindingReport`, `ImpactReason`, `PlanOperation`, `DeclarationSnapshot`, `captureConfiguration`, `ConfigurationValue` |
| 运行 / Execution | `createHost`, `Host`, `HostOptions`, `ApplyResult`, `HostStatus`, `InstallationState` |
| 资源 / Resources | `LifetimeContext`, `ChildLifetime`, `LifetimeOwnership`, `Task`, `Cleanup`, `BackgroundTask`, `LifetimePhase`, `LifetimeSnapshot`, `UnresolvedObligation`, `Disposable`, `AsyncDisposable`, `Resource`, `Awaitable`, `disposeSymbol`, `asyncDisposeSymbol` |
| 事件与贡献 / Events and contributions | `Contribution`, `ContributionView`, `ContributionOperations`, `EventListener`, `EventArguments`, `EventOperations` |
| 观察与错误 / Observation and errors | `HostSnapshot`, `InstallationSnapshot`, `GroupSnapshot`, `SnapshotView`, `isLogger`, `Logger`, `DougongError`, `ConfigurationValidationError`, `RecordedFailure`, `isError`, `isCancellationReason`, `ErrorSnapshot`, `ErrorDetails` |

插件上下文的 `LifetimeContext` 只授予工作与资源登记能力；`child(label)` 返回可以提前释放的 `ChildLifetime`。关闭整个 Instance 始终经过 Engine。

`LifetimeContext.acquire(factory)` 返回的 Promise 以冻结的 `{ resource }` 回执完成；解构即可取得实际被接管的资源。

契约身份取自令牌自身的数据字段。来自另一个 JavaScript Realm 的令牌，可凭相同的 `kind` 和 `id` 声明服务提供、声明依赖和借用服务。

## Host 与安装

`HostOptions` 包含 `name`、初始 `installations`、初始 `groups`、日志与错误报告端口和退出超时。每个 Installation ID 在 Host 中唯一，Group ID 也是应用声明的稳定身份。

```ts
const change = host.change();
const group = change.group("workspace");
const installation = change.install(plugin, { id: "search", group, configuration });
await host.apply(await host.plan(change));
await host.start();

const next = host.change();
next.update(installation, { configuration: nextConfiguration });
const plan = await host.plan(next);
await host.apply(plan);

const remove = host.change();
remove.removeGroup(group);
await host.apply(await host.plan(remove));
await host.stop();
```

`installation(id)` 与 `group(id)` 只查询已提交声明。Installation 公开只读的 `id`、`groupId`、`status` 与 `origin`；Group 公开 `id` 与 `parentId`。所有变更由 ChangeSet 表达。`InstallationUpdate` 更新配置，或替换 Plugin 并携带配置与来源。

`host.use(token, callback)` 借用当前已提交 Service。`host.contributions(token)` 提供贡献视图。`host.diagnostics.get()` 读取稳定的 Host 快照，`host.diagnostics.subscribe()` 观察其失效通知；`explain(id)` 查询指定安装的服务绑定。标准 `[Symbol.asyncDispose]` 加入 stop。

## 执行与诊断

Host 状态为 `stopped`、`starting`、`running`、`changing`、`stopping`、`quarantined`。隔离是整个 Host 的终止状态，不提供原地恢复；操作边界与替换前提见[隔离后的应用处理](../guide/transactions.md#quarantine)。`Plan.report` 可序列化，不包含模块、函数、真实配置载荷或可变运行对象。`HostSnapshot` 中 Lifetime 也是普通数据快照。

订阅统一 `get/subscribe`，不重放，使用标准 Disposable 取消。`ContributionView.use(id, callback)` 借用贡献所有者；`get()` 仅给出冻结的有序 ID 数组；读取元数据和调用处理函数都通过 `use`。`EventOperations.on/emit` 支持同步或异步监听，emit 等待所有监听结果并汇总失败；每次监听调用借用其所有者。`ContributionOperations.add` 登记带 owner 的贡献。

`ErrorDetails` 给出 outcome、phase、stateRevision 和可选的安装、契约、依赖路径与影响范围。`RecordedFailure` 是有界脱离资源图的诊断投影；原始拒绝的 cause 仍由直接调用者接收。

`isCancellationReason` 按原生信号的取消原因身份分类，不把任意同名错误视为取消；带有同一原因的 `AbortError.cause` 数据属性也可建立因果。完整契约见[生命周期与资源](../guide/lifetime.md)。

`apply`、`start`、`stop` 成功时 resolve 不可变 `ApplyResult`，只含 `stateRevision` 与 `affectedInstallations`；失败 reject。无变更时保留原修订并返回空的影响列表，不附加固定成功标记。

从上一版 API 更新时，将已删除的 Host inspect 方法替换为 `host.diagnostics.get()`。删除对旧 ApplyResult outcome 字段的判断；await 正常完成后处理成功，catch 中处理失败及结构化 details。不提供别名或兼容适配器。

Host 只在选项缺省时使用默认值；显式传入 null 的名字、安装列表或分组列表会被拒绝。声明、配置和 Service 提供值记录都接受空原型及其他 realm 的原生 Object 原型。配置捕获只读取共享输入对象一次并冻结结果；循环引用和过深嵌套仍然拒绝。插件可单独传递 `context.logger` 的日志函数，释放日志作用域的权限归 Instance。Host 创建时一次性捕获日志方法，保留原后端作为接收者；错误兜底同样使用捕获的方法。

## 高级组合原语

`dougong/advanced` 供适配器与领域扩展使用，不暴露 Engine 或可变安装注册表。

| 原语 | 职责 |
| --- | --- |
| `SnapshotPublisher`、`ReadonlyMapSnapshot` | 发布快照、提供只读集合。 |
| `batchSnapshotNotifications` | 在一个同步回调中批量发布。返回 Promise 不能延长此次发布边界。 |
| `SerialQueue` | 顺序执行提交的操作。传给 `run(operation, signal)` 的信号可立即撤回仍在排队的操作。操作开始后，由它自己决定完成结果。 |
| `normalizePlainRecord` | 捕获普通记录的数据字段。插件配置请用 `captureConfiguration`。 |
| `recordFields<T>()(...keys)` | 从声明类型建立穷尽的允许字段集合，供 `normalizePlainRecord` 使用。 |
| `captureDataArray(input, label)` | 浅拷贝自有的稠密数据索引并冻结数组，不调用输入的方法或迭代器。元素的校验归调用方。 |
| `captureLogger(logger)` | 接管日志后端时一次捕获四个方法及其原始接收者。 |
| `onAbort(signal, callback)` | 观察真实取消，回调只接收一次原因；已取消时立即回调。返回的函数用于解除观察。手动派发名为 `abort` 的事件不能取消作用域。 |

`recordFields` 在编译期要求每个字段都被列出，包括可选字段和联合声明各分支的字段，并拒绝额外字段。元组每项必须是一个确定字段，不能用可能取多个字段名的联合值代替穷尽枚举。不接受无法证明完整性的宽化数组、数字或符号键，以及开放索引签名。它声明允许出现哪些字段；必填性和值的校验仍归对应输入边界。

较早的监听器调用 `stopImmediatePropagation()` 时，仍能收到真实取消。Core 和 Reactive 使用同一套原生状态读取与解绑逻辑。

Node 与浏览器使用同一份公开 API 组合：源信号的原生监听器负责订阅的存活期，`AbortSignal.any` 创建的私有依赖信号通过弱引用传递取消，避免被遗弃的订阅继续保留源信号和回调。两条入口共用一次原生状态判断与解绑；合成事件不会推进取消，解除观察只清理本次订阅，不修改源信号上的其他监听器。上游仍然存活时，临时合成信号上的订阅保持原生监听器的存活语义。

覆盖普通控制器信号的 `aborted`、`reason` 或监听方法不会改变真实取消结果。对于 `AbortSignal.timeout()` 或合成信号，Node 自身的原生监听器管理仍会读取 `aborted`：自定义 getter 抛错时，注册回滚并原样抛出该错误；若提前将它覆写为 `true`，请保留源信号或解绑函数直到观察结束，以免 Node 提前回收仍在等待的信号。

## 声明描述与可执行计划

`describePlugin(plugin, { jsonSchemaTarget })` 从 Plugin 的同一声明投影 `PluginDescriptor`，供文档、UI 与代理读取。描述不执行 setup 或 validate，不推测擦除后的 TypeScript 接口。`PluginConfigurationDescriptor.status` 区分 `none`（无配置）、`unavailable`（有验证器但无 JSON Schema 出口）、`available`（提供标准 JSON Schema 出口）；默认 target 为 `draft-2020-12`。使用 Standard Schema 1.1 的 Standard JSON Schema 协议导出输入与输出描述，无法导出的 schema 如实标记 unavailable。

`PlanReport.bindings.before/after` 展示绑定前后差异，`prepareOrder`、`stopOrder`、`publishOrder` 分别说明准备、停止与发布顺序。安装类 `PlanOperation` 携带 before/after `DeclarationSnapshot`，其中只含 pluginName 与公开 origin，不含配置载荷；分组操作只描述 id 与 parentId。`ImpactReason.previousProvider` 与 provider 保留提供者变化原因，包括可选依赖的提供者移除。
