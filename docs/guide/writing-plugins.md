# 编写插件

`definePlugin` 接受 `name`、可选的 Standard Schema `config`、`requires`、`provides` 与 `setup`。setup 的返回值必须准确匹配提供声明。配置通过 `setup(ctx, config)` 的第二个参数传入。

```ts
const COMMANDS = extensionPoint<{ title: string; run(): Promise<string> }>("editor/commands");
const SAVED = event<{ file: string }>("editor/saved");

const editor = definePlugin({
  name: "editor.main",
  requires: { storage: STORAGE, commands: COMMANDS },
  setup({ deps, lifetime, events, contributions }) {
    const session = lifetime.child("session");
    session.defer(() => closeSession());
    events.on(SAVED, ({ file }) => markSaved(file));
    contributions.add(COMMANDS, "save", {
      title: "Save",
      run: () => deps.storage.save(),
    });
  },
});
```

所有运行资源在获取时交给 Lifetime。标准资源交给 `lifetime.use(resource)`，释放函数交给 `lifetime.defer(fn)`；异步创建标准资源用 `lifetime.acquire(factory)`。声明一个依赖后通过 `ctx.deps.alias` 使用它，避免运行时动态查找隐藏依赖。

监听与贡献默认属于当前 Instance 的 Lifetime。传入 `{ lifetime: child }` 可将其归属子树。候选 Instance 可以登记监听和贡献，但直到整笔执行提交后才可被外部观察到。候选 setup 内调用 `events.emit` 会失败；将外部事件放在提交后发生的实际业务操作中。

Event 监听器可以同步返回，也可以返回 Promise。`events.emit` 等待本次所有监听结果，汇总失败后拒绝；每个调用在完成前借用监听器的 Lifetime，因此异步处理不会脱离所有权。需要独立于本次广播持续运行的后台工作时，显式使用 `lifetime.spawn`，由 Task 拥有错误报告。需要先中断才能结束的资源使用 `lifetime.interrupt`。

配置是数据：普通对象、数组、字符串、有限数字、布尔值与 null。捕获时拒绝 getter、原型对象、循环、函数、symbol 和稀疏数组；validator 的输出也再次捕获。schema 只在 plan 阶段执行一次，apply 使用已经验证的计划结果。

## 向文档与代理公开声明

```ts
const description = describePlugin(plugin);
const serialized = JSON.stringify(description);
```

`describePlugin` 从 requires/provides 直接提取别名和契约身份。示例 05 在第一次 setup 之前生成 JSON 描述，并明确显示只有 validate 的配置 schema 状态为 unavailable。支持 Standard JSON Schema 1.1 的 schema 可以给出 input/output JSON Schema；导出不会调用验证器或尝试运行插件。描述应在可信的本地声明或构建过程中生成，外部代码的 import 仍需经过 Platform 准入。
