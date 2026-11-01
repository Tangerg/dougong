# 错误码

失败通过结构化错误拒绝。`DougongError` 提供 `code`、不可变 `details` 和可选原始 `cause`；`ConfigurationValidationError` 额外提供捕获后的 Standard Schema issues。`PlatformError` 使用 `PlatformErrorCode`，`PermissionDeniedError` 提供 manifestName 与 denied。

从旧版迁移时，读取 Registration 诊断的调用方应将 `snapshot.manifestName` 和 `snapshot.denied` 改为 `snapshot.fields?.manifestName` 和 `snapshot.fields?.denied`。直接捕获的 `PermissionDeniedError` 仍提供类型化字段。自定义诊断可用 `new RecordedFailure(error, fieldNames)` 选择最多八个字段，每个名称限 1 至 256 个字符。记录器只读取对象自身的数据属性，保留有界的字符串或字符串数组。

`details.outcome` 区分 rejected、restored、quarantined。Promise 正常完成即成功，`ApplyResult` 只返回状态修订与影响安装；无须用固定字段再次判断成功。`RecordedFailure` 与 `ErrorSnapshot` 是有界诊断投影，直接调用者仍获得原始失败。参数与协议误用可能抛 TypeError；取消服从所属 AbortSignal，并不等于成功提交。

| 错误码 | 含义与处理 |
| --- | --- |
| `ACTIVATION_FAILED` | 激活执行失败；检查 cause 与 Core 的结构化执行结果。 |
| `ACTIVATION_STALE` | 激活准备期间 Core 状态改变；重新预览与激活。 |
| `API_INCOMPATIBLE` | Artifact 要求的宿主 API 范围不匹配。 |
| `ARTIFACT_DUPLICATE` | 相同名称与 revision 已存在；使用真正的新发行身份。 |
| `ARTIFACT_IDENTITY` | 加载的 Plugin 身份与 Artifact Manifest 不一致。 |
| `ARTIFACT_UNAVAILABLE` | Artifact 不属于可用 Catalog 或已被移除。 |
| `BUSY` | 该资源所有者仍有前台借用，不能同步封闭此操作。 |
| `CHANGE_CONFLICT` | 同一变更声明包含冲突意图。 |
| `CHANGE_FOREIGN` | ChangeSet 不属于该 Host。 |
| `CONFIGURATION_INVALID` | Standard Schema 验证失败，读取 issues 修正输入。 |
| `CONTRACT_CONFLICT` | 同一 Contract ID 被赋予不同契约类别。 |
| `CONTRIBUTION_UNAVAILABLE` | 贡献已经撤销或其所有者不再接受调用。 |
| `EVENT_BEFORE_COMMIT` | 候选 setup 尚未提交，不能向外广播事件。 |
| `GROUP_CONFLICT` | 分组 ID 或声明重复冲突。 |
| `GROUP_CYCLE` | 分组父子声明形成环。 |
| `GROUP_FOREIGN` | Group 句柄不属于该 Host。 |
| `GROUP_MISSING` | 引用的父分组或目标分组不存在。 |
| `GROUP_REMOVED` | 变更试图使用已经移除的 Group。 |
| `HOST_BUSY` | 正在转换或受影响代次仍有前台借用；等待工作完成，基线未变时可重用尚未消费的 Plan。 |
| `HOST_QUARANTINED` | 整个 Host 已终止可用性；检查 status、error 与 unresolved，按[隔离处置流程](../guide/transactions.md#quarantine) 处理。 |
| `INSTALLATION_CONFLICT` | 安装 ID 或声明重复冲突。 |
| `INSTALLATION_FOREIGN` | Installation 句柄不属于该 Host。 |
| `INSTALLATION_REMOVED` | 变更试图使用已经移除的 Installation。 |
| `LIFETIME_DISPOSED` | 资源所有者已封闭，不能接收新的资源或任务。 |
| `MANIFEST_INVALID` | 发行声明不符合 Manifest 协议。 |
| `MODULE_INVALID` | 模块没有提供有效的 Plugin 声明。 |
| `MODULE_LOAD_FAILED` | Loader 失败；检查 cause 和输入 Reference。 |
| `PERMISSION_DENIED` | 准入策略拒绝权限；检查 denied 与当前策略。 |
| `PLAN_CONSUMED` | Plan 已经使用过，必须生成新计划。 |
| `PLAN_FOREIGN` | Plan 没有由此 Host 签发。 |
| `PLAN_STALE` | 计划的基线版本已过期；重新规划。 |
| `PLATFORM_BUSY` | 最终激活转换或释放正在执行；待返回后再发起新的 Platform 变更。 |
| `PLATFORM_UNAVAILABLE` | Platform 或其 Catalog 正在关闭或已经关闭。 |
| `PROVIDES_INVALID` | setup 的返回值与 provides 声明不一致。 |
| `REGISTRATION_CYCLE` | 选择的发行依赖图包含循环。 |
| `REGISTRATION_DEPENDENCY_INACTIVE` | 所需发行依赖没有可激活的选择。 |
| `REGISTRATION_DEPENDENCY_INCOMPATIBLE` | 依赖选择的版本不满足 Manifest 范围。 |
| `REGISTRATION_DEPENDENCY_MISSING` | 缺少 Manifest 声明的发行依赖。 |
| `REGISTRATION_UNAVAILABLE` | Registration 不可用或不属于此 Platform。 |
| `SELECTION_SUPERSEDED` | 等待期间用户选择已更新；旧结果不能覆盖它。 |
| `SERVICE_CONFLICT` | 同一装配域存在重复 Service 提供者。 |
| `SERVICE_CYCLE` | 必需 Service 绑定形成循环。 |
| `SERVICE_MISSING` | 缺少必需 Service 的提供者。 |
| `SERVICE_UNAVAILABLE` | 当前没有可借用的已提交 Service 代次。 |
| `SHUTDOWN_TIMEOUT` | 退出等待超时，底层义务仍可继续存在。 |
| `TRANSITION_FAILED` | 执行转换失败；通过 details.outcome 和 cause 判断恢复结果。 |
