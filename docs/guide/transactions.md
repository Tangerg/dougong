# 计划与执行

所有安装变更通过 `ChangeSet → Plan → apply`。`start` 与 `stop` 编译为同一个 Engine 状态转换，不维护另一套执行路径。

```ts
const change = host.change();
change.update(installation, { plugin: nextPlugin, configuration: nextConfiguration });
const plan = await host.plan(change);
inspectBeforeApplying(plan.report);
const result = await host.apply(plan);
console.log(result.stateRevision, result.affectedInstallations);
```

规划捕获配置、运行 schema、检查契约与分组、确定绑定、计算受影响闭包，并生成只读 `PlanReport`。规划不会运行 setup、获取插件运行资源或发布监听；schema 验证器是应用代码，应保持无外部副作用。`report` 包含基线版本、操作、前后绑定、来源变化、原因、准备顺序、停止顺序、发布顺序与原子发布承诺。

Plan 只能由签发它的 Host 使用一次。apply 在任何执行副作用之前核对归属、是否已消费和 `stateRevision`。另一个提交或改变运行状态的失败会使旧 Plan 失效。任务计数和通知次数不会使 Plan 失效。

调用 `host.plan(change, signal)` 可以撤回这一次规划。取消后，调用以信号的原始原因拒绝，草案中的待安装项转为 `removed`，同一修订上的其他 Plan 仍然有效。已经签发的 Plan 继续遵守原有的修订和单次使用规则。

Core 只签发可执行的 Plan：声明不成立时，`host.plan()` 直接拒绝，报告不包含永远为空的 blockers 列表。签发后的执行预检如果遇到不可恢复的契约种类冲突，该 Plan 被消费；应修正声明后重新规划。Platform 的数据预览仍可以列出真实阻碍。

如果 schema 验证等待期间另一个操作已提交，规划以 [`PLAN_STALE`](../reference/errors.md) 拒绝；Host 已隔离时则以 [`HOST_QUARANTINED`](../reference/errors.md) 拒绝。应根据当前 Host 重新创建变更。已经签发的 Plan 中，尚未提交的 Installation 会在基线版本失效时立即变成 `removed`。保留过期 Plan 供查看报告，不会因此保留旧的可执行内容。

契约种类归 Host 的注册表所有；运行中的插件或应用可以在不提交图变更的情况下登记一种契约。规划会在签发 Plan 前用注册表核对候选图。如果候选 setup 等待期间相同 ID 已被登记为另一种契约，本次发布不会开始；Core 按 setup 失败的路径清理候选并恢复原声明。种类冲突本身不会使 Host 隔离。

基线失效时，等待中的 `plan()` 不必等验证器返回便会拒绝，也不会再启动后续验证器。已经运行的验证器仍可能完成自己的外部工作，其迟到结果不能影响 Host。

## 执行和结果

执行前先检查受影响代次的前台借用。有借用时返回 [`HOST_BUSY`](../reference/errors.md)，不产生执行副作用，也不消费 Plan。获准执行后，先封闭受影响旧代次的入口，等待其后台工作退出并释放资源，再按依赖顺序准备候选 Instance；所有候选准备成功后，监听、贡献、服务与来源共同发布。

候选失败后清理候选，并尝试用已验证配置重建原声明。重建的是新的 Instance，不会复活已释放的旧对象。无法完成清理或恢复时，Host 进入隔离。失败释放仅阻止仍被它依赖的提供者，其他能安全退出的分支继续清理，独立错误汇总报告。

同一依赖层内，各 Installation 按声明的提交顺序开始准备，异步 setup 可以按任意顺序完成。发布也遵循声明的提交顺序。更新保留 Installation 的原有位置，草稿中的新 Installation 在提交时获得位置。同一项变更可以移除重叠的 Group 子树。因这些 Group 被连带移除的 Installation 会按已提交的声明顺序出现在影响清单中，每个只列一次。

`stopOrder` 描述依赖顺序，不规定清理完成的先后时间。独立消费者可以并行退出；每个提供方都要等实际绑定到该代次的消费者成功退出后才能释放。

| 结果 | 调用者观察 |
| --- | --- |
| 成功完成，包括无须变更 | resolve：`{ stateRevision, affectedInstallations }` |
| 预检拒绝 | reject：按错误 code 处理；带结果分类时 `details.outcome` 为 `rejected` |
| 已恢复旧声明 | reject：`details.outcome` 为 `restored` |
| 无法安全恢复 | reject：`details.outcome` 为 `quarantined` |

这里承诺框架发布的原子可见性。插件已经发送的网络请求、写入的文件或外部系统副作用不会自动回滚。`plan.report.execution.externalEffectsRollback` 明确为 false。

成功只有 Promise 正常完成这一种表达，`ApplyResult` 不再附加固定的成功字段。它返回实际状态修订和影响安装；空变更、重复 start 或重复 stop 不制造新的提交。错误的 `details.outcome` 描述失败后的状态，不是另一套成功返回协议。

忙碌拒绝后，先等待当前工作完成。原 Plan 尚未消费且基线修订未变时，可以再次 apply；若已发生其他状态转换，则应根据当前状态重新规划。不要在被借用的服务回调内部等待会移除自身的变更。Plan 过期或已消费都不能通过复制报告重新获得权限。

## 隔离后的应用处理 {#quarantine}

**`quarantined` 是整个 Host 的终止状态。没有解除隔离、原地恢复或自动重试清理的入口。** 这是完整执行图的健康边界；[设计理由](../reference/architecture.md#quarantine) 解释了为什么依赖精确的清理不等于局部恢复服务。

已有 Installation 句柄仅保留最终状态和来源。尚未规划的 ChangeSet 被撤销，释放暂存声明并拒绝新操作，其中未提交的 Installation 变为 `removed`。后续清理进度通过诊断视图观察。

| 隔离后操作 | 行为与用途 |
| --- | --- |
| `host.diagnostics.get()` | 读取错误、保留实例及其资源义务；退出完成后仍可读取最终快照 |
| `host.diagnostics.subscribe()` | 观察真实迟到进度；全部义务和转换完成、最终通知交付后自动结束，之后的新订阅被拒绝 |
| `installation(id)`、`group(id)`、`explain(id)` | 检查保留的声明身份与绑定；这些数据不代表可执行权限 |
| `change()`、`plan()`、`apply()`、`start()`、`stop()` | 拒绝并报告 [`HOST_QUARANTINED`](../reference/errors.md)，不会开启一条重试退出或恢复路径 |
| `host[Symbol.asyncDispose]()` | 复用 stop，也会拒绝；标准释放语法不会消除已有故障 |
| 新的 `host.use()` 或贡献借用 | 拒绝访问已封闭的执行所有者 |
| 已开始的任务、获取或清理 | 可能迟到完成；超时和封闭入口不能强制终止任意 JavaScript |

`snapshot.unresolved` 按 installation 和 generation 列出仍被保留的 Instance；Lifetime 快照进一步显示任务、获取、借用、子树及失败义务。一个提供者可能因消费者仍未退出而被保留，即使它自身没有清理错误。恢复 setup 失败也可能使 Host 隔离，而资源已经全部释放，因此 **空的 unresolved 不是健康判据**，必须读取 `snapshot.status`。

超时后，已启动的退出工作仍可能继续，并使诊断更新；它不会启动新的清理重试，也不使 Host 自动离开隔离。诊断进度不推进 `stateRevision`。

Engine 在终态执行和真实退出都结束后统一封存观察。诊断与 Host 贡献视图保留最终只读快照，并断开执行图和回调；它们不负责重试清理或决定执行状态。存在未完成义务时不会提前封存，普通 stop/start 仍保留可用视图。

应用应在管理该 Host 的边界执行以下步骤：

1. 停止向该 Host 分派新请求，将对应功能标记为不可用。不要通过重放 apply、start、stop 或 Platform 激活来尝试恢复；外部副作用可能已经发生。
2. 保存 `host.diagnostics.get()` 的有界快照和直接调用的失败结果，记录 installation、generation、错误阶段与未完成义务。需要观察迟到完成时，继续订阅同一个诊断视图；这用于解释故障，不是恢复授权。
3. 由应用或执行器的真正所有者处理旧边界。若插件运行在可终止的 Worker 或进程中，由其监督者回收执行器，并按外部系统契约核实连接、租约、锁或其他独占资源。若代码仍在同一 realm 且无法证明它已停止，仅创建新 Host 不足以安全接管；应升级到能够回收该执行边界的处理方式。
4. 在旧边界和需要独占的外部资源得到处理后，从应用保存的声明、配置或 Artifact 选择创建新的 Host。诊断快照不含完整配置和模块，不能当作可执行恢复镜像。

应用对故障后的资源处置负有责任，框架不会重复执行任意清理回调。`shutdownTimeoutMilliseconds` 为每个 Lifetime 的退出提供等待预算，不是整个 Host 退出的总时限；顺序清理可能经历多个预算，也不会因此修复资源泄漏。需要独立可用性的功能应事先放在不同 Host；需要强制终止能力时，还必须配套真实的执行隔离。
