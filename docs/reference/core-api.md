# Core API 参考

主包 `dougong` 是实际内核；默认导出面只有一个明确的运行模型。本页记录公开协议；边界、取舍与禁止事项的理由见[架构与设计理由](./architecture.md)，执行与故障处置见[计划与执行](../guide/transactions.md)。

## 公开导出

| 责任 | 导出 |
| --- | --- |
| 契约 / Contracts | `service`, `extensionPoint`, `event`, `optional`, `ContractKind`, `ContractValue`, `Service`, `ExtensionPoint`, `Event`, `OptionalService`, `Requirement` |
| 插件 / Plugins | `definePlugin`, `describePlugin`, `PluginDescriptor`, `PluginConfigurationDescriptor`, `PluginDescriptionOptions`, `Plugin`, `AnyPlugin`, `PluginContext`, `Requirements`, `Provisions`, `ResolvedRequirement`, `ResolvedRequirements`, `ProvidedServices`, `InstanceMetadata` |
| 安装与计划 / Installation and planning | `ChangeSet`, `Group`, `Installation`, `InstallationOptions`, `InstallationArguments`, `InstallationUpdate`, `InstallationOrigin`, `InitialInstallation`, `Plan`, `PlanReport`, `BindingReport`, `ImpactReason`, `PlanOperation`, `DeclarationSnapshot`, `captureConfiguration`, `ConfigurationValue` |
| 运行 / Execution | `createHost`, `Host`, `HostOptions`, `ApplyResult`, `HostStatus`, `InstallationState` |
| 资源 / Resources | `LifetimeContext`, `ChildLifetime`, `LifetimeOwnership`, `Task`, `Cleanup`, `BackgroundTask`, `LifetimePhase`, `LifetimeSnapshot`, `UnresolvedObligation`, `Disposable`, `AsyncDisposable`, `Resource`, `Awaitable`, `ResolvedValue`, `disposeSymbol`, `asyncDisposeSymbol` |
| 事件与贡献 / Events and contributions | `Contribution`, `ContributionView`, `ContributionOperations`, `EventListener`, `EventArguments`, `EventOperations` |
| 观察与错误 / Observation and errors | `HostSnapshot`, `InstallationSnapshot`, `GroupSnapshot`, `SnapshotView`, `isLogger`, `Logger`, `DougongError`, `ConfigurationValidationError`, `RecordedFailure`, `isError`, `isCancellationReason`, `ErrorSnapshot`, `ErrorDetails` |

插件上下文的 `LifetimeContext` 只授予工作与资源登记能力；`child(label)` 返回可以提前释放的 `ChildLifetime`。关闭整个 Instance 始终经过 Engine。

`LifetimeContext.acquire(factory)` 返回的 Promise 以冻结的 `{ resource }` 回执完成；解构即可取得实际被接管的资源。

契约身份取自令牌自身的数据字段。来自另一个 JavaScript Realm 的令牌，可凭相同的 `kind` 和 `id` 声明服务提供、声明依赖和借用服务。

## Host 与安装

`HostOptions` 包含 `name`、初始 `installations`、初始 `groups`、日志与错误报告端口和退出超时。每个 Installation ID 在 Host 中唯一，Group ID 也是应用声明的稳定身份。

`createHost` 按初始列表中的每个 Plugin 推断其配置输入；异构列表也保留各自的配对。`InitialInstallation<typeof plugin>` 和 `InstallationOptions<typeof plugin>` 从同一 Plugin 类型派生配置要求。输入允许 `undefined` 时可以省略配置，包括 `void`、可选输入与 schema 默认值；否则必须提供配置。schema 转换后的输出只供 setup 使用，安装声明仍须提供转换前的输入。配置不能反向扩宽 Plugin 类型来通过检查。

`setup` 接收配置输出的深只读视图：记录字段、嵌套对象、数组与元组都不能修改。调用方仍可提供普通可变输入；Core 捕获输入和验证后的输出，Plugin 不获得这些数据的写权限。schema 的输入与原始输出类型保持各自含义，无 schema 的显式配置类型也遵守同一只读规则。类型保留普通 interface、联合与可选字段；有限数值、稠密数组和普通数据对象等要求仍由运行时捕获边界校验。

`ChangeSet.install` 保留同样的 Plugin 与输入关联。`InstallationArguments<First | Second>` 分发完整的 `[plugin, options]` 元组，`InitialInstallation` 从这条规则投影初始声明。联合 Plugin 与独立选择的配置会被拒绝，`void` 分支也不能掩盖另一个分支必填的输入。在多个 Plugin 中选择时，应保留完整配对：

```ts
const declaration: InstallationArguments<typeof textPlugin | typeof numberPlugin> = useText
  ? [textPlugin, { id: "selected", configuration: "text" }]
  : [numberPlugin, { id: "selected", configuration: 42 }];
const installation = change.install(...declaration);
```

返回的 `Installation<First | Second>` 无法确定实际安装的分支，因此仅更新配置时，输入必须同时满足所有可能分支。替换 Plugin 时，配置与新 Plugin 保持配对；只有新 Plugin 能接受全部可能的旧输入时，才可以省略配置并继承已捕获的输入，否则必须显式提供配置。替换为无配置 Plugin 时，使用 `configuration: undefined` 明确清空可能存在的旧输入。一个 Plugin 自身声明的输入联合类型（例如 `string | number`）仍然接受其声明的每一种输入。

在联合选择前使用 `definePlugin` 或明确的 `Plugin<...>` 注解，使 schema 输入保持不变性；相同输出不能让较窄的输入被自动宽化。未注解的原始对象按 TypeScript 结构规则推断，调用前已被宽化或擦除的输入关系无法由框架恢复。这一约束只存在于类型层，不给 Plugin 增加运行字段。

`install` 的显式类型参数现在描述完整参数元组：`install<InstallationArguments<typeof plugin>>(plugin, options)`；原有 `install<typeof plugin>` 形式已经移除。普通调用继续自动推断类型，无须显式参数。

需要传递安装命令时，直接保存 `const install = change.install`，可保留完整签名与已有绑定。针对已知 Plugin 集合的包装函数可以接收 `InstallationArguments<First | Second>` 并展开调用。TypeScript 5.9.3 无法证明任意泛型 `P` 的 `InstallationArguments<P>` 在再次展开后仍保留关联，因此这种泛型装饰器不能直接转发；将它宽化为 `AnyPlugin` 会丢失输入契约。

保存带类型的 Host 选项时，可用 `HostOptions<readonly [typeof firstPlugin, typeof secondPlugin]>` 描述异构列表。显式使用 `AnyPlugin` 或不带类型参数的 `HostOptions` 会擦除具体输入类型，适用于动态加载边界；未知配置仍经过原有的数据捕获与 schema 验证，不增加独立的配置状态。

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

`host.use(token, callback)` 借用当前已提交 Service，对于回调的结果类型 `Result` 返回 `Promise<ResolvedValue<Awaited<Result>>>`；成功时解构冻结回执的 `value`，失败时接收原拒绝原因。`host.contributions(token)` 提供贡献视图。`host.diagnostics.get()` 读取稳定的 Host 快照，`host.diagnostics.subscribe()` 观察其失效通知；`explain(id)` 查询指定安装的服务绑定。标准 `[Symbol.asyncDispose]` 加入 stop。

## 执行与诊断

Host 状态为 `stopped`、`starting`、`running`、`changing`、`stopping`、`quarantined`。隔离是整个 Host 的终止状态，不提供原地恢复；操作边界与替换前提见[隔离后的应用处理](../guide/transactions.md#quarantine)。`Plan.report` 可序列化，不包含模块、函数、真实配置载荷或可变运行对象。`HostSnapshot` 中 Lifetime 也是普通数据快照。

订阅统一 `get/subscribe`，不重放，使用标准 Disposable 取消。`ContributionView.use(id, callback)` 借用贡献所有者，同样返回 `Promise<ResolvedValue<Awaited<Result>>>`；`get()` 仅给出冻结的有序 ID 数组；读取元数据和调用处理函数都通过 `use`。`EventOperations.on/emit` 支持同步或异步监听，emit 等待所有监听结果并汇总失败；每次监听调用借用其所有者。`ContributionOperations.add` 登记带 owner 的贡献。

`SnapshotView.subscribe` 与 `batchSnapshotNotifications` 的回调必须同步完成。公开类型拒绝直接返回 Promise、PromiseLike、可能带有可调用 `then` 的对象，以及包含这些异步分支的联合结果；普通同步返回值与包含 Promise 的数据对象仍然允许。动态输入或已经被上游声明为 `() => void` 的回调仍由运行时校验，已经开始的异步续体无法撤回。需要后台工作时，在同步通知中显式调用 `Lifetime.spawn`。

`SnapshotPublisher` 的错误报告函数也必须同步完成，并且只执行报告副作用，不返回业务结果。若简写回调意外返回 `Array.push` 的计数，改用不返回值的代码块，例如 `error => { errors.push(error); }`。同步抛出的报告错误会与原订阅错误一起保留；动态输入仍经过运行时同步校验。

`batchSnapshotNotifications(operation, reportNotificationFailure?)` 可显式指定通知的终端错误边界。订阅者及其错误报告函数都失败时，该边界接收包含两个原始错误的 `AggregateError`，不改变 `operation` 的结果；操作体自己的异常仍由调用者接收。省略第二参数会继承当前边界，完全没有边界时仍向直接调用者同步抛出通知错误。合并通知保留首次入队时的边界；嵌套批次返回或后续重复失效不能转移这项责任。订阅者和报告函数触发的新通知继承正在投递的通知边界。

终端报告函数也必须同步完成且不返回业务结果。它自身失败时，两个阶段的错误通过独立微任务作为未捕获错误报告，不覆盖已经确定的业务结果。通知仍然同步投递，相关快照仍然原子可见。Core 和 Platform 在自己的发布与取消边界绑定既有 `onError` 或 logger 通道；真正的发布、资源清理和执行失败仍遵守原来的拒绝与隔离规则。

`ErrorDetails` 给出 outcome、phase、stateRevision 和可选的安装、契约、依赖路径与影响范围。`RecordedFailure` 是有界脱离资源图的诊断投影；原始拒绝的 cause 仍由直接调用者接收。

`isCancellationReason` 按原生信号的取消原因身份分类，不把任意同名错误视为取消；带有同一原因的 `AbortError.cause` 数据属性也可建立因果。完整契约见[生命周期与资源](../guide/lifetime.md)。

`apply`、`start`、`stop` 成功时 resolve 不可变 `ApplyResult`，只含 `stateRevision` 与 `affectedInstallations`；失败 reject。无变更时保留原修订并返回空的影响列表，不附加固定成功标记。

从上一版 API 更新时，将已删除的 Host inspect 方法替换为 `host.diagnostics.get()`。删除对旧 ApplyResult outcome 字段的判断；await 正常完成后处理成功，catch 中处理失败及结构化 details。不提供别名或兼容适配器。

Host 只在选项缺省时使用默认值；显式传入 null 的名字、安装列表或分组列表会被拒绝。声明、配置和 Service 提供值记录都接受空原型及其他 realm 的原生 Object 原型。配置捕获只读取共享输入对象一次并冻结结果；循环引用和过深嵌套仍然拒绝。插件可单独传递 `context.logger` 的日志函数，释放日志作用域的权限归 Instance。Host 创建时一次性捕获日志方法，保留原后端作为接收者；错误兜底同样使用捕获的方法。

`Logger<Result>` 描述四个日志方法的返回合同，默认要求同步完成且无业务返回值。`HostOptions.logger` 与 `context.logger` 使用这个默认合同；异步的 Host 错误报告应交给 `onError`。Platform 的日志仅用于终端错误接收，使用 `Logger<unknown>`，允许异步或其它被忽略的返回值，并观察其失败而不改写已提交结果。Core 的终端兜底同样防御动态输入产生的异步失败，但这不放宽插件作用域的同步要求。

`isLogger` 只确认四个方法的形状，收窄到 `Logger<unknown>`，不能证明它们同步。`captureLogger` 保留已知输入逐个方法的返回类型；未知输入得到 `Logger<unknown>`。两者都不能把未知或异步后端转换成同步后端。上游已经擦除为 `void` 的返回信息仍由作用域日志的运行时检查保护。

## 高级组合原语

`dougong/advanced` 供适配器与领域扩展使用，不暴露 Engine 或可变安装注册表。

| 原语 | 职责 |
| --- | --- |
| `SnapshotPublisher`、`ReadonlyMapSnapshot` | 发布快照、提供只读集合。 |
| `batchSnapshotNotifications` | 在一个同步回调中批量发布，并可绑定通知的终端错误边界。返回 Promise 不能延长此次发布边界。 |
| `SerialQueue` | 顺序执行提交的操作。`run(operation, signal)` 返回 `Promise<ResolvedValue<Awaited<T>>>`，`settled` 只等待完成；信号可立即撤回仍在排队的操作。操作开始后，由它自己决定结算。 |
| `normalizePlainRecord` | 捕获普通记录的数据字段。插件配置请用 `captureConfiguration`。 |
| `recordFields<T>()(...keys)` | 从声明类型建立穷尽的允许字段集合，供 `normalizePlainRecord` 使用。 |
| `resolveValue(value)` | 按共享异步结果协议解析一次，返回 `Promise<ResolvedValue<Awaited<T>>>`；冻结的 `{ value }` 回执保留已完成结果的身份。 |
| `captureDataArray(input, label)` | 浅拷贝自有的稠密数据索引并冻结数组，不调用输入的方法或迭代器。元素的校验归调用方。 |
| `captureLogger(logger)` | 接管日志后端时一次捕获四个方法及其原始接收者，保留已知方法的返回类型；未知输入只证明方法形状。 |
| `onAbort(signal, callback)` | 观察真实取消，回调只接收一次原因；已取消时立即回调。返回的函数用于解除观察。手动派发名为 `abort` 的事件不能取消作用域。 |

`recordFields` 在编译期要求每个字段都被列出，包括可选字段和联合声明各分支的字段，并拒绝额外字段。元组每项必须是一个确定字段，不能用可能取多个字段名的联合值代替穷尽枚举。不接受无法证明完整性的宽化数组、数字或符号键，以及开放索引签名。它声明允许出现哪些字段；必填性和值的校验仍归对应输入边界。

较早的监听器调用 `stopImmediatePropagation()` 时，仍能收到真实取消。Core 和 Reactive 使用同一套原生状态读取与解绑逻辑。

Node 与浏览器使用同一份公开 API 组合：源信号的原生监听器负责订阅的存活期，`AbortSignal.any` 创建的私有依赖信号通过弱引用传递取消，避免被遗弃的订阅继续保留源信号和回调。两条入口共用一次原生状态判断与解绑；合成事件不会推进取消，解除观察只清理本次订阅，不修改源信号上的其他监听器。上游仍然存活时，临时合成信号上的订阅保持原生监听器的存活语义。

覆盖普通控制器信号的 `aborted`、`reason` 或监听方法不会改变真实取消结果。对于 `AbortSignal.timeout()` 或合成信号，Node 自身的原生监听器管理仍会读取 `aborted`：自定义 getter 抛错时，注册回滚并原样抛出该错误；若提前将它覆写为 `true`，请保留源信号或解绑函数直到观察结束，以免 Node 提前回收仍在等待的信号。

## 声明描述与可执行计划

`describePlugin(plugin, { jsonSchemaTarget })` 从 Plugin 的同一声明投影 `PluginDescriptor`，供文档、UI 与代理读取。描述不执行 setup 或 validate，不推测擦除后的 TypeScript 接口。`PluginConfigurationDescriptor.status` 区分 `schema_absent`（未声明运行时配置 schema）、`unavailable`（有验证器但无 JSON Schema 出口）、`available`（提供标准 JSON Schema 出口）；默认 target 为 `draft-2020-12`。`schema_absent` 不能说明是否需要配置，其结构与必填性未知；例如 `definePlugin<{ port: number }>(...)` 可以没有 schema，但安装仍必须提供配置。需要机器可发现的输入与输出描述时，由同一配置声明通过 Standard Schema 1.1 的 Standard JSON Schema 协议导出，不另加一份必填性标记。

`PluginDescriptor.requires` 保留依赖种类与可选性的关联：Service 的 `optional` 可以为 true 或 false，ExtensionPoint 的 `optional` 始终为 false。按 `kind` 分支读取时，公开类型保留这条保证。

`PlanReport.bindings.before/after` 展示绑定前后差异，`prepareOrder`、`stopOrder`、`publishOrder` 分别说明准备、停止与发布顺序。安装类 `PlanOperation` 携带 before/after `DeclarationSnapshot`，其中只含 pluginName 与公开 origin，不含配置载荷；分组操作只描述 id 与 parentId。`ImpactReason.previousProvider` 与 provider 保留提供者变化原因，包括可选依赖的提供者移除。

`BindingReport.optional` 同时判别提供者是否可以缺失：`optional: false` 的 `provider` 必为字符串；只有 `optional: true` 才允许 `provider: undefined`。必需 Service 的提供者缺失时，图构建直接拒绝，不会生成这种报告。`Host.explain()`、诊断快照和 Plan 使用同一个绑定类型。
