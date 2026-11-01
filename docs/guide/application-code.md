# 应用代码消费

应用与代理通过稳定契约使用当前运行代次。`host.use` 在同步边界取得一个借用，等待回调的完整结果后释放。会破坏借用代次的变更返回 `HOST_BUSY`；获准切换并封闭入口后，受影响代次拒绝新借用。未受影响的代次可以继续服务。

```ts
const answer = await host.use(SEARCH, async (search) => {
  return await search.query("Dougong");
});
```

回调中不要把服务引用保存到长期全局变量。TypeScript 无法阻止引用逃逸；API 定义的是调用期间的生命周期承诺。

贡献中的可执行函数也要借用其所有者：

```ts
const commands = host.contributions(COMMANDS);
const id = commands.get()[0];
if (id !== undefined) {
  await commands.use(id, (command) => command.run());
}
```

`get()` 返回按发布顺序排列的冻结 ID 数组，每个 ID 都包含所有者标识。保留快照不会保留处理函数。原来用 `get().values()` 或按键取值的代码，应枚举这些 ID，通过 `await commands.use(id, command => command.title)` 等借用投影展示字段，执行时再借用当前值。`use` 借用当前已发布的条目，不可用时返回 rejected Promise。条目的值更新或被替换，即使 ID 不变，也发布新的快照。Host 切换期间，快照停在上一次发布，发生变化的条目直到发布才能借用。

`host.diagnostics.get()` 是读取 Host 稳定快照的唯一入口。订阅不会立即重放，通知没有载荷，回调中调用 `get()` 读取。取消订阅使用 `subscription[Symbol.dispose]()`。错误诊断使用有界的 `RecordedFailure`，不保留插件异常里的任意资源图。

CLI、UI 和代理复用 `change → plan → apply`。先展示 `plan.report` 的绑定、影响范围、顺序和执行承诺，再执行该 Plan；若状态已变，重新规划。

`host.change()` 返回只能登记意图的冻结对象。应用不能提取其底层操作列表、安装记录或提交权限。尚未提交的 Installation 也不持有 Host；只有提交后的句柄才投影 Engine 状态。
