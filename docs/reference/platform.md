# Platform 规范

`@dougongjs/platform` 仅依赖 `dougong` 的正式公开入口。运行值导出 `createPlatform`、`defineManifest`、`MemoryLoader`、`ImportLoader`、`PermissionSet`、`PlatformError`、`PermissionDeniedError`。

类型导出：`Platform`, `PlatformOptions`, `PlatformStatus`, `Registration`, `RegistrationStatus`, `RegistrationSnapshot`, `PlatformSnapshot`, `Artifact`, `ArtifactInput`, `ArtifactDescriptor`, `ArtifactOrigin`, `Catalog`, `Manifest`, `ManifestInput`, `Loader`, `Authorizer`, `AdmissionRequest`, `ActivationOptions`, `ActivationPreviewOptions`, `ActivationPreview`, `ActivationBlocker`, `PlatformErrorCode`

## 目录、选择、执行

| 入口 | 行为 |
| --- | --- |
| `catalog.add(input)` | 捕获不可变的发行声明和配置 |
| `catalog.get(name, revision)` / `catalog.list()` | 查阅已知 Artifact |
| `catalog.remove(artifact)` | 移除发现记录 |
| `registrations()` | 枚举当前可用于命令的 Registration 句柄，返回冻结数组 |
| `select(artifact)` | 设置 Registration 的选择意图 |
| `preview(registrations, { remove })` | 数据层检查和延迟验证清单 |
| `activate(registrations, { remove, signal })` | 准入、加载并编译为一笔 Core Plan |
| `trigger(event, options)` | 从已选 Manifest 派生激活集合 |
| `remove(...registrations)` | 复用同一 Core Plan 执行移除 |
| `[Symbol.asyncDispose]()` | 取消待完成激活并移除该 Platform 拥有的执行 |

`PlatformOptions.id` 区分同一 Host 中的交付命名空间。可选 `group` 必须已提交并属于给定 Host。`apiVersion` 由宿主声明，Manifest 的范围检查是交付准入事实。

Artifact 的 `revision` 是调用方给定的内容或发行身份；没有依赖时钟生成的版本。复用要求同一已提交 Installation 上的 revision 和经验证的 Manifest 都与选择一致。依赖键、激活事件和权限的声明顺序不影响匹配。Registration 的 `selectionRevision` 用于拒绝过期激活。`activeOrigin` 由 Installation origin 派生，Core 提交通知中已经能够看到正确来源。

## 状态和边界

Platform 状态为 `active/disposing/disposed`。Registration 状态为 `selected/activating/removing/installed/failed/quarantined/removed`，反映选择、正在执行的操作及 Core 执行事实。调用方取消不会覆盖上次实际失败；当前选择激活成功后清除该错误。激活目标及移除列表只捕获数组自己的索引数据。稀疏数组和访问器会被拒绝，不会调用 getter。

`ActivationPreview.deferred` 明确包含 admission、module_validation、configuration_validation、core_binding、setup。预览不是运行验证通过的凭证。activate 捕获选择版本与 Artifact 身份，准备完成后再次核对，过期结果不能覆盖新选择。

Manifest dependencies 负责发行依赖；Plugin requires 负责真实能力绑定。动态导入图属于 bundler/HMR 适配器，不能从这两个图猜测。示例 12 展示将 bundler 影响集合提交为一笔激活计划。

Platform 构造时捕获 Loader 和 Authorizer 的方法，并保留各自的接收对象。Loader 是结构协议；ImportLoader 用同一 realm 的动态导入，MemoryLoader 适合测试与受控模块表。PermissionSet 是声明权限集合的 Authorizer 实现，不提供操作系统隔离。

最终激活交接（Core 规划、最终准入与 apply）或 Core 释放期间，新发起的变更和释放命令以 `PLATFORM_BUSY` 拒绝，避免回调等待排在自己后面的命令。此前已接纳的激活仍能完成，交接之前的加载保持并发。等外层调用完成后再发起后续命令。

在配置验证或最终准入期间取消，Platform 会结束等待并释放命令占用；迟到的结果不能提交。取消不能撤销模块副作用或已经交给 `host.apply` 的 Plan。已没有已提交 Installation 的 Registration 仍可直接移除。
