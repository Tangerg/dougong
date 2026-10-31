# Core API 参考

主包 `dougong` 是实际内核；默认导出面只有一个明确的运行模型。本页记录公开协议；边界、取舍与禁止事项的理由见[架构与设计理由](./architecture.md)，执行与故障处置见[计划与执行](../guide/transactions.md)。

## 公开导出

| 责任 | 导出 |
| --- | --- |
| 契约 / Contracts | `service`, `extensionPoint`, `event`, `optional`, `ContractKind`, `ContractValue`, `Service`, `ExtensionPoint`, `Event`, `OptionalService`, `Requirement` |
| 插件 / Plugins | `definePlugin`, `describePlugin`, `PluginDescriptor`, `PluginConfigDescriptor`, `PluginDescriptionOptions`, `Plugin`, `AnyPlugin`, `PluginContext`, `Requirements`, `Provisions`, `ResolvedRequirement`, `ResolvedRequirements`, `ProvidedServices`, `InstanceMeta` |
| 安装与计划 / Installation and planning | `ChangeSet`, `Group`, `Installation`, `InstallationOptions`, `InstallationUpdate`, `InstallationOrigin`, `InitialInstallation`, `Plan`, `PlanReport`, `BindingReport`, `ImpactReason`, `PlanOperation`, `DeclarationSnapshot`, `captureConfig`, `ConfigValue` |
| 运行 / Execution | `createHost`, `Host`, `HostOptions`, `ApplyResult`, `HostStatus`, `InstallationState` |
| 资源 / Resources | `LifetimeContext`, `LifetimeOwnership`, `Task`, `Cleanup`, `BackgroundTask`, `LifetimePhase`, `LifetimeSnapshot`, `UnresolvedObligation`, `Disposable`, `AsyncDisposable`, `Resource`, `Awaitable`, `disposeSymbol`, `asyncDisposeSymbol` |
| 事件与贡献 / Events and contributions | `Contribution`, `ContributionView`, `ContributionOperations`, `EventListener`, `EventArguments`, `EventOperations` |
| 观察与错误 / Observation and errors | `HostSnapshot`, `InstallationSnapshot`, `GroupSnapshot`, `SnapshotView`, `isLogger`, `Logger`, `DougongError`, `ConfigValidationError`, `RecordedFailure`, `isError`, `isCancellationReason`, `ErrorSnapshot`, `ErrorDetails` |

## Host 与安装

`HostOptions` 包含 `name`、初始 `installations`、初始 `groups`、日志与错误报告端口和退出超时。每个 Installation ID 在 Host 中唯一，Group ID 也是应用声明的稳定身份。

```ts
const change = host.change();
const group = change.group("workspace");
const installation = change.install(plugin, { id: "search", group, config });
await host.apply(await host.plan(change));
await host.start();

const next = host.change();
next.update(installation, { config: nextConfig });
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

订阅统一 `get/subscribe`，不重放，使用标准 Disposable 取消。`ContributionView.use(id, fn)` 借用贡献所有者；`get()` 仅给出集合快照。`EventOperations.on/emit` 支持同步或异步监听，emit 等待所有监听结果并汇总失败；每次监听调用借用其所有者。`ContributionOperations.add` 登记带 owner 的贡献。

`ErrorDetails` 给出 outcome、phase、stateRevision 和可选的安装、契约、依赖路径与影响范围。`RecordedFailure` 是有界脱离资源图的诊断投影；原始拒绝的 cause 仍由直接调用者接收。

`apply`、`start`、`stop` 成功时 resolve 不可变 `ApplyResult`，只含 `stateRevision` 与 `affectedInstallations`；失败 reject。无变更时保留原修订并返回空的影响列表，不附加固定成功标记。

从上一版 API 更新时，将已删除的 Host inspect 方法替换为 `host.diagnostics.get()`。删除对旧 ApplyResult outcome 字段的判断；await 正常完成后处理成功，catch 中处理失败及结构化 details。不提供别名或兼容适配器。

## 高级组合原语

正式子路径 `dougong/advanced` 导出 `SnapshotPublisher`、`ReadonlyMapSnapshot`、`SerialQueue`、`normalizePlainRecord`、`batchSnapshotNotifications`。它们服务于下游宿主适配器和领域扩展，不暴露 Engine 或可变安装注册表。共享发布原语让 UI 适配与 Platform 复用同一观察语义。

`normalizePlainRecord` 规范化具名记录边界；配置数据请用 `captureConfig`，其约束和错误与计划中的配置捕获保持一致。

## 声明描述与可执行计划

`describePlugin(plugin, { jsonSchemaTarget })` 从 Plugin 的同一声明投影 `PluginDescriptor`，供文档、UI 与代理读取。描述不执行 setup 或 validate，不推测擦除后的 TypeScript 接口。`PluginConfigDescriptor.status` 区分 `none`（无配置）、`unavailable`（有验证器但无 JSON Schema 出口）、`available`（提供标准 JSON Schema 出口）；默认 target 为 `draft-2020-12`。使用 Standard Schema 1.1 的 Standard JSON Schema 协议导出输入与输出描述，无法导出的 schema 如实标记 unavailable。

`PlanReport.bindings.before/after` 展示绑定前后差异，`prepareOrder`、`stopOrder`、`publishOrder` 分别说明准备、停止与发布顺序。安装类 `PlanOperation` 携带 before/after `DeclarationSnapshot`，其中只含 pluginName 与公开 origin，不含配置载荷；分组操作只描述 id 与 parentId。`ImpactReason.previousProvider` 与 provider 保留提供者变化原因，包括可选依赖的提供者移除。
