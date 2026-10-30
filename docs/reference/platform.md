# Platform 规范

`@dougongjs/platform` 仅依赖 `dougong` 的正式公开入口。运行值导出 `createPlatform`、`defineManifest`、`MemoryLoader`、`ImportLoader`、`PermissionSet`、`PlatformError`、`PermissionDeniedError`。

类型导出：`Platform`, `PlatformOptions`, `PlatformStatus`, `Registration`, `RegistrationStatus`, `RegistrationSnapshot`, `PlatformSnapshot`, `Artifact`, `ArtifactInput`, `ArtifactDescriptor`, `ArtifactOrigin`, `Catalog`, `Manifest`, `ManifestInput`, `Loader`, `Authorizer`, `AdmissionRequest`, `ActivationOptions`, `ActivationPreviewOptions`, `ActivationPreview`, `ActivationBlocker`, `PlatformErrorCode`

## 目录、选择、执行

| 入口 | 行为 |
| --- | --- |
| `catalog.add(input)` | 捕获不可变的发行声明和配置 |
| `catalog.get(name, revision)` / `catalog.list()` | 查阅已知 Artifact |
| `catalog.remove(artifact)` | 移除发现记录 |
| `select(artifact)` | 设置 Registration 的选择意图 |
| `preview(registrations, { remove })` | 数据层检查和延迟验证清单 |
| `activate(registrations, { remove, signal })` | 准入、加载并编译为一笔 Core Plan |
| `trigger(event, options)` | 从已选 Manifest 派生激活集合 |
| `remove(...registrations)` | 复用同一 Core Plan 执行移除 |
| `[Symbol.asyncDispose]()` | 取消待完成激活并移除该 Platform 拥有的执行 |

`PlatformOptions.id` 区分同一 Host 中的交付命名空间。可选 `group` 必须已提交并属于给定 Host。`apiVersion` 由宿主声明，Manifest 的范围检查是交付准入事实。

Artifact 的 `revision` 是调用方给定的内容或发行身份；没有依赖时钟生成的版本。Registration 的 `selectionRevision` 用于拒绝过期激活。`activeOrigin` 由 Installation origin 派生，Core 提交通知中已经能够看到正确来源。

## 状态和边界

Platform 状态为 `active/disposing/disposed`。Registration 状态为 `selected/activating/removing/installed/failed/quarantined/removed`，反映选择、正在执行的操作及 Core 执行事实。错误保持可观察；失败不得伪装为成功安装。

`ActivationPreview.deferred` 明确包含 admission、module_validation、configuration_validation、core_binding、setup。预览不是运行验证通过的凭证。activate 捕获选择版本与 Artifact 身份，准备完成后再次核对，过期结果不能覆盖新选择。

Manifest dependencies 负责发行依赖；Plugin requires 负责真实能力绑定。动态导入图属于 bundler/HMR 适配器，不能从这两个图猜测。示例 12 展示将 bundler 影响集合提交为一笔激活计划。

Loader 是结构协议；ImportLoader 用同一 realm 的动态导入，MemoryLoader 适合测试与受控模块表。PermissionSet 是声明权限集合的 Authorizer 实现，不提供操作系统隔离。
