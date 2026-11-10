# 架构与设计理由

Dougong 将能力声明、执行变更、资源所有权和插件交付分开，让应用、插件作者和代理能够从同一份事实理解系统。本文解释边界为什么存在、代价是什么，以及哪些行为不能由便利 API 隐藏。[Core API](./core-api.md) 负责导出与签名，[计划与执行](../guide/transactions.md) 负责调用流程与失败处理，[项目规则](https://github.com/Tangerg/dougong/blob/main/PROJECT_RULES.md) 约束实现。

## 一个事实，一个所有者

“只有一份状态”不足以判断所有权。关键问题是：谁能推进这个事实，其他对象是否也能独立改变它？

| 事实 | 唯一推进者 | 其他表示的职责 |
| --- | --- | --- |
| 已提交声明、绑定、Instance、运行修订与隔离状态 | Engine | Host 提供命令；Installation、Group 是只读身份；诊断是投影 |
| 某个 Plan 的执行权限与消费状态 | 该 Host 内的计划权限记录 | Plan 暴露不可变报告；报告 JSON 没有执行权限 |
| 任务、获取、借用、子树与释放义务 | Lifetime | Task、Cleanup 和资源快照提供各自的有限协议 |
| 可用的 Artifact 修订 | Catalog | Manifest 与 Reference 描述不可变发行物 |
| 选中的 Artifact 及选择修订 | Registration | Platform 的激活操作捕获并验证这个选择 |
| 实际提交的实现及其来源 | Core 的同一次提交 | Registration 的 activeOrigin 从 Core 投影 |

例如，激活新发行物失败后，“选中的版本”和“正在运行的版本”可以不同。这是两个含义不同的事实，不需要选出一份覆盖另一份。反之，Platform 若另存一套“已激活版本”并自行推进，就会和 Core 竞争同一个事实。

`host.diagnostics.get()` 是读取 Host 快照的标准入口，`subscribe()` 观察其失效通知。读取和订阅复用同一个 SnapshotView，因此没有再提供一个同义的快照方法。`explain(id)` 回答的是指定安装的服务绑定问题。快照可以缓存、序列化或渲染，不能反向提交执行状态。

## 原子能力为何保持正交

| 原子 | 适合表达 | 不承担的职责 |
| --- | --- | --- |
| Service | 有稳定契约身份的单一能力 | 动态查找、隐式路由或无限期借用 |
| ExtensionPoint | 可增减的开放贡献集合 | 替消费者决定排序、选择或业务调度 |
| Event | 一次瞬时广播的事实，等待监听完成 | 保存当前状态、可靠消息队列或事务提交 |
| Lifetime | 运行资源及其退出义务 | 安装命名、权限判定或业务依赖选择 |

Plugin 组合这些原子。一个命令系统可以用 ExtensionPoint 声明命令，用贡献的 `use()` 借用执行，用 Event 通知已发生的业务事实，用 Lifetime 释放监听和任务；不需要命令插件基类或另一套注册与销毁协议。UI 状态和业务调度属于应用层，它们可以复用 `@dougongjs/reactive`，不应塞进 Engine。

Group 只表达安装归属与批量移除。它不会让同名 Service 隐式遮蔽，也不会建立权限或安全边界。静态多实例能力使用显式 Contract 身份；运行时租户或工作区选择使用 Service 参数。这样读者能从声明和调用点知道究竟在使用谁。

## 依赖引用为何在代次内保持稳定

Service 依赖全部写在 `requires` 中，解析后的值放在 `context.dependencies`。每个契约在一个 Host 的装配图中只能有一个提供者；缺失的可选依赖为 `undefined`。提供者变化时，受影响消费者随之重建，而不是把已有对象背后的实现悄悄换掉。

这会增加一次变更需要重建的范围，但消费者可以用普通 TypeScript 对象和函数推理，不必考虑代理在任意调用点切换目标。实际绑定图也能同时用于计划解释、启动顺序和安全退出。ExtensionPoint 的动态集合不构成静态 Service 依赖边；执行贡献时通过借用其所有者保护生命周期。

应用通过 `host.use(contract, callback)` 使用 Service。借用在回调结果完成前一直有效；成功结果通过冻结的 `{ value }` 回执交付，回执不拥有资源或延长借用。会破坏该代次的变更遇到前台借用时返回 [`HOST_BUSY`](errors.md)，在产生副作用之前拒绝；切换封闭入口后，不再允许受影响代次接收新借用。这比返回可无限期保留的服务引用更有边界，但 TypeScript 无法阻止应用将回调内的对象保存到全局，调用者仍必须遵守借用协议。

## 为何先规划，再执行

ChangeSet 收集意图，Plan 固化在一个 `stateRevision` 上的验证结果和执行安排，Engine 执行该安排。CLI、UI、代理和 Platform 使用同一条 `change → plan → apply` 路径；没有“预览用的近似规划器”和另一套真正执行的规则。

规划检查最终声明图、配置、绑定和影响范围；它不运行插件 setup。配置只接受不可变捕获的数据，验证输出也被捕获，防止调用者在预览后修改输入。验证器仍是应用代码，应避免外部副作用；框架不能把任意验证器变成纯函数。恢复旧声明时复用已经验证的配置输出，不重新询问一个可能变化的验证器。

Plan 同时绑定 Host、状态修订和一次性权限。序列化报告只能传递说明，不能跨进程恢复执行权限。外来、过期或已消费的 Plan 在执行副作用之前被拒绝；忙碌拒绝不消费 Plan，等待后仍需满足原状态修订。任务进度会使诊断更新，却不推进图修订；无变更操作和失败的启动也不会制造一次虚假的图提交。

成功通过 Promise 正常完成表达。`ApplyResult` 只携带 `stateRevision` 和 `affectedInstallations`，避免再用一个固定成功标记重复表示同一结果。失败通过拒绝传播，结构化错误说明拒绝、恢复或隔离的区别。

## 原子发布承诺到哪里为止

运行中的变更先停止受影响的旧代次，再按依赖顺序准备候选。所有候选准备成功后，服务、事件监听、贡献和来源共同发布。在提交前，候选监听和贡献不可见，setup 不能向外广播公共 Event。未受影响的实例可以继续存在，不需要为一次局部变更重启整个 Host。

原子性针对框架管理的发布。它不承诺变更期间零停机，不是数据库事务，也不会撤回插件已发送的网络请求、已写入的文件或模块导入副作用。需要事务或补偿的业务操作应在自己的外部系统边界中实现，不能由 Core 猜测。

候选准备失败后，先安全清理候选，再用旧声明和已验证配置创建新的旧版本 Instance。恢复的承诺是重新建立旧声明图，不是复活被释放的 JavaScript 对象。恢复成功仍然拒绝原操作，因为请求的新状态没有实现；恢复本身失败或清理不完整则隔离整个 Host。

## 释放为何遵循关系而不是数组位置

Instance 的资源归 Lifetime。退出先封闭入口、撤销发布并取消工作，再执行中断、等待任务与获取、最后释放资源。子树失败不能授权父树释放，消费者失败也不能授权提供者释放：未退出的代码仍可能使用这些资源。

例如 A 使用 B、B 使用 C，而 D 与它们无依赖。A 清理失败时，B 和 C 必须保留，D 仍应释放。独立的 E 也清理失败时，其错误要一并报告；不能因 A 是线性退出列表中的第一个失败而跳过后续所有实例。这里使用的是各代次真正绑定的依赖关系，不能把候选图或相同安装 ID 下的另一代次当成当前资源依赖。

阻止释放的范围与停止服务的范围不同。清理阶段尽量释放能够安全释放的独立分支；无法证明释放完成的义务继续保留。超时仅表示等待预算耗尽，并不表示底层操作已结束。重复调用退出也不能自动重试一个可能已经完成部分外部操作的清理函数。

## 为什么隔离整个 Host，而且不原地恢复 {#quarantine}

Host 是一次完整执行图的健康承诺。隔离表示 Engine 无法再保证该承诺，可能存在退出超时、清理失败或恢复失败。保留某条失败分支同时宣称剩余 Host 健康，需要新的局部可用性、跨分支借用和恢复协议；仅仅给安装加一个故障标记无法提供这些保证。

当前模型明确选择：**隔离是整个 Host 的终止状态，没有解除隔离、重试清理或原地恢复 API。** 它撤销可用性，拒绝新的变更与 Service 借用，并保留可观察的资源义务。代价是一个插件的清理故障会使该 Host 整体不可用；依赖精确的清理减少保留资源的范围，不改变这一可用性承诺。

提前释放子树或 defer 句柄失败也遵循同一决策。资源义务及失败事实归 Lifetime，Host 可用性归 Engine，诊断通知只投影结果。Engine 进入隔离时同步封闭入口并使 Plan 失效，然后等待安全清理；这次终态提交只推进一次修订，清理进展不会再次推进它。正在准备或恢复的各代执行使用真实绑定参与清理，不能在隔离之后重新提交健康状态。

已经启动的退出工作可能在超时后继续推进，诊断会反映迟到完成。即使 `unresolved` 随后变少，也不会自动把 Host 标成健康：完成资源释放不等于重新建立完整声明图，原操作也已经失败。应用不能清空诊断、重复 start 或重新创建 Platform 来宣称故障消失。

把互相独立的可用性域部署到不同 Host，可以缩小逻辑故障范围；需要强制终止失控代码时，应把执行放入可回收的 Worker、进程或其他实际隔离边界。多个同线程 Host 不能终止泄漏的异步工作或撤销外部副作用。创建新 Host 之前仍须处理旧执行边界及其外部资源，具体步骤见[隔离后的应用处理](../guide/transactions.md#quarantine)。

## 交付层为何不拥有另一套执行事实

Platform 负责发现发行物、记录选择、准入和加载，然后把依赖闭包和移除编译成一个 Core Plan。选中修订变化后，旧加载结果不能提交；准入发生在加载前，并在激活前重新检查。Core 原子提交实现及 origin，因此交付层不会通过补写来源造成一段无法解释的中间状态。

准入是在允许某次操作，不是给同 realm 的 JavaScript 建立沙箱。Loader 的完整性保证、代码隔离和模块缓存语义必须由具体实现声明。仅凭 Manifest 权限列表或 Group 结构，无法约束任意插件访问全局环境。

## 物理目录对应逻辑责任

`dougong` 包直接实现内核；`@dougongjs/platform` 是依赖内核的交付层；`@dougongjs/reactive` 独立并通过结构协议组合。包边界有实际责任，没有仅为转发同一能力而存在的 Core 门面包。

| Directory | Responsibility |
| --- | --- |
| `packages/dougong/src/contracts` | Identity, protocols, error and logging contracts |
| `packages/dougong/src/internal` | Shared low-level record, queue and protocol primitives |
| `packages/dougong/src/observation` | Stable snapshots and publication |
| `packages/dougong/src/lifetime` | Resource ownership and shutdown |
| `packages/dougong/src/events` | Owned event listeners and awaited broadcast |
| `packages/dougong/src/contributions` | Owned contribution collections |
| `packages/dougong/src/composition` | Plugin declarations, configuration, graph and Plan |
| `packages/dougong/src/inspection` | Derived diagnostic projections |
| `packages/dougong/src/execution` | Instance execution and the single Engine |
| `packages/platform/src/artifacts` | Immutable distribution declarations |
| `packages/platform/src/catalog` | Known Artifacts and selection handles |
| `packages/platform/src/admission` | Admission policy |
| `packages/platform/src/loaders` | Module delivery |
| `packages/platform/src/activation` | Selection-aware compilation to Core Plans |
| `packages/reactive/src` | Signals, Readable bridge and owned observation |
| `examples/src` | Application-level composition |
| `tooling/architecture` | Responsibility and emitted API guards |
| `tooling/release` | Artifact verification and publishing |
低层不知道高层。contracts 不导入 execution；lifetime 不导入 events 或 contributions；事件与贡献使用 Lifetime 的发布和借用原子能力。inspection 从事实构建稳定快照；observation 是可复用低层协议，不能与高层诊断目录混合。

跨包只走 exports 定义的入口。`dougong/advanced` 为下游组合保留正式原语；没有核心注册表或私有控制口。物理目录按这些责任划分，模块守卫对新目录默认拒绝，新增责任必须显式设计。

## 人与代理使用同一协议

结构化 `PlanReport` 说明要改什么以及为什么受影响，`HostSnapshot` 说明当前已提交状态和保留义务，错误 details 说明失败所处阶段和结果。UI、CLI 与代理只投影这些事实，不根据日志文本重建第二套状态机。

实际配置内容、服务对象和函数不复制进报告。`describePlugin` 从同一 Plugin 声明生成能力描述；配置 schema 必须使用显式的标准出口，不能从任意 TypeScript 类型或运行中的服务对象猜测。缺少 schema 出口就明确说明不可提供，这比给自动化调用者一个看似完整却不可信的契约更可靠。

## 参考设计

设计报告比较了能力声明、生命周期、加载与隔离等不同职责。以下是相关项目的一手文档；各自机制用于校验具体边界，而不是整体复制一个框架。

- [Backstage services](https://backstage.io/docs/backend-system/architecture/services/) and [extension points](https://backstage.io/docs/backend-system/architecture/extension-points/)
- [pluggy](https://pluggy.readthedocs.io/en/stable/)
- [OSGi Declarative Services](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)
- [VS Code activation events](https://code.visualstudio.com/api/references/activation-events)
- [Vite plugin API](https://vite.dev/guide/api-plugin) and [Rollup plugin development](https://rollupjs.org/plugin-development/)
- [Fx lifecycle](https://uber-go.github.io/fx/lifecycle.html)
- [ECMAScript resource management](https://tc39.es/ecma262/multipage/managing-memory.html)
- [Standard Schema](https://standardschema.dev/)
