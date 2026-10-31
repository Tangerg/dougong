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
const id = commands.get().keys().next().value;
if (id !== undefined) {
  await commands.use(id, (command) => command.run());
}
```

`get()` 返回不可变集合快照，适合枚举与渲染；`use` 是执行边界。不要将读取快照当作无限期运行权限。

`host.diagnostics.get()` 是读取 Host 稳定快照的唯一入口。订阅不会立即重放，通知没有载荷，回调中调用 `get()` 读取。取消订阅使用 `subscription[Symbol.dispose]()`。错误诊断使用有界的 `RecordedFailure`，不保留插件异常里的任意资源图。

CLI、UI 和代理复用 `change → plan → apply`。先展示 `plan.report` 的绑定、影响范围、顺序和执行承诺，再执行该 Plan；若状态已变，重新规划。

`host.change()` 返回只能登记意图的冻结对象。应用不能提取其底层操作列表、安装记录或提交权限。尚未提交的 Installation 也不持有 Host；只有提交后的句柄才投影 Engine 状态。
