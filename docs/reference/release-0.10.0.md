# Dougong 0.10.0 Release Notes

0.10.0 明确了每个异步结果、回调、资源、选择和发布操作的所有者，并在公开类型边界上强制执行。本次发布包含相对 0.9.0 的破坏性变更。升级步骤见[迁移指南](../guide/migrating-to-0.10.md)。

## 发布包

| 包 | 版本与职责 |
| --- | --- |
| `dougong` | 0.10.0；契约、插件、计划、执行、资源与诊断 |
| `@dougongjs/platform` | 0.10.0；Artifact 目录、选择、准入、加载与激活 |
| `@dougongjs/reactive` | 0.10.0；独立、零依赖的信号、观察与桥接 |

```sh
pnpm add dougong@0.10.0
```

## 破坏性变更

- Node.js 运行要求为 `^24.22.0 || >=26.10.0`，不再支持 Node.js 22。取消只依据所属 signal 的原因本身，或自身 `cause` 就是该原因的 `AbortError` 来判定。
- `Task.result`、`host.use`、`ContributionView.use` 和 `SerialQueue.run` 返回 `Promise<ResolvedValue<T>>`，成功结果通过冻结的 `{ value }` 回执交付。结果泛型使用 `Awaited<T>`，`Task<T>` 表示最终载荷类型，`ObservationTask` 只报告完成。获取资源仍返回 `{ resource }` 回执。外部 Promise 通过其公开 `then` 观察。
- 快照与 Reactive 回调（包括 `batch` 和 `computed`）在类型边界拒绝可识别的异步返回，`Observer` 新增结果类型参数。`Logger` 默认要求同步且无业务返回值的方法；未知的日志输入保留未知的方法返回类型。
- 显式传给 `ChangeSet.install` 的类型参数表示完整参数元组，例如 `InstallationArguments<typeof plugin>`。更新安装时每个 Plugin 与其输入保持配对。`BindingReport` 将必需绑定与字符串提供者关联。
- `platform.select` 接收 Artifact 数组，并按相同位置返回 Registration。Artifact 与 Registration 是名义身份。`ImportLoader` 只接受字符串引用。
- `use` 与 `acquire` 拒绝控制既有 Lifetime 登记的句柄；在同一份已加载的 Core 内，一个外部资源只有一个 Lifetime 所有者。无法读取的 setup 输出以 `PROVIDES_INVALID` 报告并带上对应安装。

## 新增能力

- `dougong` 新增 `ResolvedValue` 与 `InstallationArguments` 类型，`dougong/advanced` 新增 `resolveValue` 与 `recordFields`。
- `@dougongjs/reactive` 导出 `asyncDisposeSymbol` 与 `disposeSymbol`，供独立使用的消费者释放资源。

## 修复

- 异步边界观察真正拥有结算的操作。被装饰的原生 Promise 不能再提前结束借用、清理、队列槽位或准入，也不能在 Lifetime 接管前替换资源。
- 子 Lifetime 提前释放、清理或后代退出失败时，通过 Engine 的终止转换隔离整个 Host。隔离后，准备与恢复无法再提交健康状态。
- Lifetime 封闭前已登记的获取仍可交付资源，供消费者完成最后一次 flush；真实取消后才到达的资源由原所有者回收。
- Host 使已捕获的 Plan 失效时，最终准入停止等待；Core 取得执行权之前，准备过程保持可取消；无效的 Authorizer 返回值在加载或激活副作用之前被拒绝。
- 移除 Group 时正确处理重叠子树。有界失败快照保留外部原生错误以及 `SuppressedError` 的两个分支。
- 配置更新受所有可能被替换的已安装声明约束；Standard Schema 的 issue 协议在捕获时不保留无关元数据。
- 发布工具每次发布只捕获一个源提交、推送目标和 npm 仓库，要求显式指定 dist-tag，回滚时只撤销本次实际完成的替换。

## 发布验证

完整门禁在 Node.js 24.22.0 上通过：87 个文件共 1221 个测试，以及按包覆盖率阈值、类型、lint、格式、未使用代码、循环依赖、架构边界、包构建、公开 API、六种浏览器环境中的打包消费者和中英双语文档。CI 从运行基线派生版本矩阵，在每个受支持分支的最低版本及当前版本上执行完整验证。

完整变更：[v0.9.0…v0.10.0](https://github.com/Tangerg/dougong/compare/v0.9.0...v0.10.0)。[English release notes](../en/reference/release-0.10.0.md)。
