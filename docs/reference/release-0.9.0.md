# Dougong 0.9.0 Release Notes

0.9.0 将 Dougong 收敛为显式计划、结构化借用与资源所有权内核，并重建交付层的发行、选择和激活流程。本次发布包含相对 0.8.3 的破坏性变更。升级步骤见[迁移指南](../guide/migrating-to-0.9.md)。

## 发布包

| 包 | 版本与职责 |
| --- | --- |
| `dougong` | 0.9.0；契约、插件、计划、执行、资源和诊断 |
| `@dougongjs/platform` | 0.9.0；Artifact 目录、选择、准入、加载和激活 |
| `@dougongjs/reactive` | 0.9.0；独立且零外部依赖的信号、观察与桥接 |

```sh
pnpm add dougong@0.9.0
```

Platform 和 Reactive 按需添加。旧 `@dougongjs/core` 已合入 `dougong`，不再单独发布 0.9.0。复用型组合原语从正式子入口 `dougong/advanced` 导出。

## 破坏性变更

- 安装变更统一为 `ChangeSet → host.plan() → host.apply()`。Installation 和 Group 是稳定只读身份；旧的直接安装、句柄更新、删除、ready 和 commit 路径被移除。
- 应用通过 `host.use` 借用服务。贡献视图返回有序 ID 数组，通过 `ContributionView.use` 读取和执行；使用中的代次受到变更保护。
- PluginContext 明确分为 `dependencies`、`lifetime`、`events`、`contributions`、`metadata` 和 `logger`。配置字段统一为 `configuration`，相关类型与错误名也使用完整拼写。
- 配置输入与验证输出只接受不可变数据；资源对象、Promise、函数、访问器、循环和稀疏数组被拒绝。规划捕获配置，回滚复用已验证值。
- 根 `LifetimeContext` 只登记资源和工作；可提前释放的子树使用 `ChildLifetime`。句柄统一使用标准释放符号。异步获取返回 `{ resource }` 回执。
- 无法安全清理或恢复时，整个 Host 进入终止性的 `quarantined` 状态。失败分支保留实际依赖的提供者，独立安全分支继续释放；迟到完成不恢复可用性。
- Platform 通过 Catalog 保存不可变 Artifact，通过 Registration 保存选择意图，实际来源从 Core Installation 投影。显式 revision、稳定 Platform ID 和预览/激活取代旧注册与 placeholder 流程。
- 权限错误的诊断字段位于 `ErrorSnapshot.fields`；Core 不再内置交付领域字段。直接捕获的权限异常保留类型化属性。
- Firefox 支持下限提升至 124；Node.js 运行要求为 `^24.22.0 || >=26.10.0`，取消适配仅使用公开原语。发行类型支持 Bundler 与 NodeNext 解析。

## 新增能力

- Plan 提供绑定前后变化、影响原因、停止、准备和发布顺序；执行权限绑定 Host、修订和单次使用。调用方可取消等待中的规划。
- `describePlugin` 投影契约与配置描述，支持 Standard JSON Schema 1.1 出口，不运行 setup 或验证器。
- Lifetime 提供标准资源接管、异步获取和阻塞 I/O 中断；诊断列出未完成资源义务。
- `bridge(owner, source)` 显式连接跨 bundle、跨副本的响应式源；无需共享全局依赖收集器。
- Platform 支持将依赖闭包及同次移除编译为一笔 Core Plan；准入覆盖直接激活和同一 Platform 中被重启的已提交 Artifact。

## 修复

- 取消等待时解除对加载器、验证器及授权器的引用，即使外部 Promise 永不完成，也不让已经结束的请求继续拥有 Engine 或交付能力。
- 复用已经捕获的 schema 协议，避免重复组合插件声明后验证包装层不断嵌套导致栈溢出。
- 在选择、移除和释放操作触发同步取消回调前，先提交可观察的状态投影。
- 收紧任务、借用、事件、贡献、配置和释放句柄的权限边界；失败释放不会被重复调用伪装成成功。
- 取消以原生 AbortSignal 状态为准，手动派发 abort 事件或阻断事件传播不能伪造或吞掉框架的取消。
- 释放桥接后解除对信号及 computed 订阅图的引用；在观察替换期间重新核对取消，避免启动已退出的代次。
- 修正批处理中的订阅成员确定、computed 循环恢复及不合协议的异步句柄结果处理。

## 发布与验证

发布使用经隔离消费者验证的同一组 tarball，核对哈希、完整入口、声明、依赖和 runtime 文件；上传后从 npm 读回并逐文件比对，再记录 Git 标签。发布与恢复显式传递 npm dist-tag，预发布版本必须指定通道。

完整门禁覆盖 936 个测试、按包覆盖率阈值、类型、lint、格式、未使用代码、循环依赖、架构边界、包构建、公开 API、打包消费者和中英双语文档。CI 从运行基线派生版本矩阵，在每个受支持分支的最低版本及当前版本上执行完整验证。

完整变更：[v0.8.3…v0.9.0](https://github.com/Tangerg/dougong/compare/v0.8.3...v0.9.0)。[English release notes](../en/reference/release-0.9.0.md)。
