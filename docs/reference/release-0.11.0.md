# Dougong 0.11.0 Release Notes

0.11.0 收敛执行状态与资源义务的所有权，修复隔离后的持续退出、配置与快照边界，并统一公开报告的命名。本次发布包含相对 0.10.0 的破坏性变更，升级步骤见[迁移指南](../guide/migrating-to-0.11.md)。

## 发布包

`dougong`、`@dougongjs/platform` 和 `@dougongjs/reactive` 同步发布为 0.11.0。

```sh
pnpm add dougong@0.11.0
```

## 破坏性变更

- `SerialQueue.settled` 改为 `settled()` 方法，只等待调用前已经提交的操作。
- `PlanReport` 移除重复的 `publishOrder`；保留 `stopOrder`、`prepareOrder` 与原子发布承诺。影响原因使用 `started`、`stopped`、`providerChanged`，分组移除操作使用 `removeGroup`。
- 无运行时配置 schema 的描述状态由 `none` 改为 `schemaAbsent`，不再暗示插件没有配置。Platform 预览使用 `moduleValidation`、`configurationValidation`、`coreBinding`；Artifact 规划错误的阶段为 `artifactPlanning`。
- Lifetime 前台借用的忙碌错误码由 `BUSY` 改为 `LIFETIME_BUSY`。
- 配置类型递归只读；`acquire` 的泛型表示工厂返回类型，并验证其最终资源。Installation、Registration、未完成义务及错误快照通过联合类型保留字段关联，调用方应先缩窄状态或种类。
- 运行环境必须具有可信的原生 AbortSignal 组合行为，具体版本见[运行环境要求](../guide/getting-started.md)。`onAbort` 回调必须同步完成。

## 修复与内部整理

- Engine 单独推进已提交的图与修订。失败启动记录诊断而不推进修订，原本有效的 Plan 仍可使用；成功提交清除旧失败。
- 隔离后按每个运行代次的真实依赖继续退出。等待借用或消费者不会阻塞初次隔离报告；迟到失败更新诊断而不恢复可用性、重试失败清理或推进修订。
- 快照通知与错误报告器的失败沿所属通知边界报告，不覆盖已经确定的提交结果。终态视图断开运行资源，准备中的依赖与资源交接保持原所有权。
- Reactive bridge 保留重入读取的最新结果及订阅者错误；验证诊断把非有限数字属性键编码为文本，避免 JSON 将其变成 null。
- 发布上传保留真实终端，使 npm 的网页二次验证可以正常启动；注册表查询仍遵守进程组截止期限。
- 按职责拆分身份、选项捕获、贡献存储与借用、退出义务、错误记录和快照投影，保持包依赖方向与公开入口一致。

## 发布验证

发布脚本在目标版本上执行完整 `pnpm check` 门禁，覆盖生成文件、类型、lint、格式、测试与按包覆盖率、未使用代码、依赖与架构边界、构建、公开 API、六种浏览器环境中的打包消费者和双语文档，再核对实际上传归档。发布认证另有真实终端回归测试。

完整变更：[v0.10.0…v0.11.0](https://github.com/Tangerg/dougong/compare/v0.10.0...v0.11.0)。[English release notes](../en/reference/release-0.11.0.md)。
