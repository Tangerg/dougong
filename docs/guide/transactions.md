# 计划与执行

所有安装变更通过 `ChangeSet → Plan → apply`。`start` 与 `stop` 编译为同一个 Engine 状态转换，不维护另一套执行路径。

```ts
const change = host.change();
change.update(installation, { plugin: nextPlugin, config: nextConfig });
const plan = await host.plan(change);
inspectBeforeApplying(plan.report);
const result = await host.apply(plan);
// result.outcome === "committed"
```

规划捕获配置、运行 schema、检查契约与分组、确定绑定、计算受影响闭包，并生成只读 `PlanReport`。规划不会运行 setup、获取资源或发布监听。`report` 包含基线版本、操作、前后绑定、来源变化、原因、准备顺序、停止顺序、发布顺序与原子发布承诺。

Plan 只能由签发它的 Host 使用一次。apply 在任何执行副作用之前核对归属、是否已消费和 `stateRevision`。另一个提交或改变运行状态的失败会使旧 Plan 失效。任务计数和通知次数不会使 Plan 失效。

执行按依赖顺序准备候选 Instance，所有候选监听、贡献和服务共同发布。对受影响旧代次，先拒绝新进入的工作，再排空既有使用并释放。候选失败后清理候选并尝试恢复原声明；无法证明资源安全时进入隔离失败。

| 结果 | 调用者观察 |
| --- | --- |
| 成功提交 | resolve：`{ outcome: "committed", stateRevision, affectedInstallations }` |
| 预检拒绝 | reject：`DougongError.details.outcome` 为 `rejected` |
| 已恢复旧声明 | reject：`details.outcome` 为 `restored` |
| 无法安全恢复 | reject：`details.outcome` 为 `quarantined` |

这里承诺框架发布的原子可见性。插件已经发送的网络请求、写入的文件或外部系统副作用不会自动回滚。`plan.report.execution.externalEffectsRollback` 明确为 false。

Host 忙碌时拒绝重入变更；调用者等待当前操作完成后重新规划。不要在被借用的服务回调内部等待会移除自身的变更。
