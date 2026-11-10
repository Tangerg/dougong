# 从 0.10 迁移到 0.11.0

三个包一起升级到 0.11.0，再执行应用的类型检查和集成测试。[Release Notes](../reference/release-0.11.0.md) 列出完整发布范围。

## 更新报告与错误分支

| 0.10.0 | 0.11.0 |
| --- | --- |
| `await queue.settled` | `await queue.settled()` |
| `PlanReport.publishOrder` | 移除；按 `prepareOrder` 展示准备顺序，用 `execution.atomicPublication` 展示原子发布保证 |
| `ImpactReason.kind: "start"` / `"stop"` | `"started"` / `"stopped"` |
| `ImpactReason.kind: "provider_changed"` | `"providerChanged"` |
| `PlanOperation.kind: "remove-group"` | `"removeGroup"` |
| `PluginConfigurationDescriptor.status: "none"` | `"schemaAbsent"`；配置要求仍由 Plugin 类型决定 |
| `ActivationPreview.deferred` 中的 `module_validation`、`configuration_validation`、`core_binding` | `moduleValidation`、`configurationValidation`、`coreBinding` |
| Artifact 规划错误的 `details.phase: "artifact_planning"` | `"artifactPlanning"` |
| Lifetime 忙碌错误码 `BUSY` | `LIFETIME_BUSY` |

`PlanReport.intent` 仍使用 `change`、`start`、`stop`。更新保存的报告、测试数据和界面分支；JSON 报告始终只是检查数据，不可还原为可执行 Plan。

## 遵守配置和资源类型边界

配置在类型上递归只读。需要修改输入时，先创建新的数据，再通过 ChangeSet 更新，不要修改捕获后的配置。

`acquire<Result>` 的类型参数表示工厂返回类型，最终 `Awaited<Result>` 必须是资源。优先让类型推断；显式指定异步工厂时使用 `acquire<Promise<Connection>>`，而不是 `acquire<Connection>`。见[生命周期与资源](./lifetime.md)。

Installation 快照按 `status` 关联 `generation` 和 `lifetime`；Registration 快照按状态关联 `activeOrigin`、`execution` 和 `error`。`UnresolvedObligation` 的 `shutdown` 分支没有登记 `id`。`ErrorSnapshot.error` 与 `suppressed` 同时出现或同时缺省。手写数据与泛型封装也需要保留这些关联。

## 检查运行与失败处理

使用[快速开始](./getting-started.md)列出的运行环境。`onAbort` 只同步登记操作；需要等待的清理通过 `lifetime.interrupt` 或 `lifetime.defer` 管理。

快照通知失败不再改变已经确定的提交结果，按[Core API](../reference/core-api.md)的通知错误边界处理。隔离后的迟到完成只细化诊断，不恢复 Host，也不推进 `stateRevision`；应用仍须处理旧边界的资源，见[事务与变更](./transactions.md#quarantine)。
