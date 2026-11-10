# 编写插件

`definePlugin` 接受 `name`、可选的 Standard Schema `configuration`、`requires`、`provides` 与 `setup`。setup 的返回值必须准确匹配提供声明。配置通过 `setup(context, configuration)` 的第二个参数传入。同一份 Core 会直接复用 `definePlugin` 产出的不可变声明，供多个 Installation 装配。传入可变声明时，每次仍会重新捕获其字段。

`requires` 与 `provides` 是依赖和提供契约的唯一声明来源；`setup` 的参数注解与返回值不能反向补出缺失声明。显式 `Plugin<...>` 类型与 `definePlugin` 遵守相同规则：非空映射必须有对应字段。别名必须是有限、确定、必填的字符串键；可选 Service 依赖写成 `requires: { cache: optional(CACHE) }`，别名 `cache` 本身仍然存在。

安装声明必须先通过 `definePlugin` 或明确的 `Plugin<...>` 注解建立作者合同，不能把未检查的原始对象直接传给 `createHost`、`change.install` 或替换操作。展开已有 Plugin 后若修改依赖、提供项、schema 或 setup，重新调用 `definePlugin` 检查组合后的完整声明；旧声明的类型证明不能授权新增别名或移除转换 schema。加载器面对未知模块时使用 `dougong/advanced` 的 `capturePluginDeclaration`，得到明确擦除具体类型的 `AnyPlugin`。

不要把分别选择的 `provides` 联合与 `setup` 返回值组合起来；它们可能落在不同分支。类型边界也拒绝可选别名、开放索引和单个别名内的 Service 令牌联合。动态选择时，先分别定义完整的 Plugin，再在这些 Plugin 之间选择；需要复用代码时，提取共同的业务能力，再由各 Plugin 组合。

没有 schema 时，配置输入直接传给 `setup`，因此输入类型必须能赋给配置输出类型。常规无 schema 插件只声明一个配置类型，例如 `definePlugin<{ port: number }>(...)`。字符串转换为数字之类的输入输出差异必须由实际的 Standard Schema 声明，不能只用类型参数声称发生了转换。schema 的输入决定安装配置的类型，输出决定 `setup` 第二个参数的类型。

配置验证结果遵循 Standard Schema 的结构协议：结果、Issue 和 PathSegment 的协议成员可以来自继承或访问器，Core 按需要各捕获一次。携带所需字段的函数对象也可实现这些协议，Core 不会调用它们。`issues` 和 `path` 的稠密数组按索引捕获，无关元数据不会被读取或保留。存在非 `undefined` 的 `issues` 即拒绝配置；成功的 `value` 再进入不可变数据捕获，最终配置值本身仍须满足纯数据约束。

```ts
const COMMANDS = extensionPoint<{ title: string; run(): Promise<string> }>("editor/commands");
const SAVED = event<{ file: string }>("editor/saved");

const editor = definePlugin({
  name: "editor.main",
  requires: { storage: STORAGE, commands: COMMANDS },
  setup({ dependencies, lifetime, events, contributions }) {
    const session = lifetime.child("session");
    session.defer(() => closeSession());
    events.on(SAVED, ({ file }) => markSaved(file));
    contributions.add(COMMANDS, "save", {
      title: "Save",
      run: () => dependencies.storage.save(),
    });
  },
});
```

所有运行资源在获取时交给 Lifetime。标准资源交给 `lifetime.use(resource)`，释放函数交给 `lifetime.defer(cleanup)`；异步创建标准资源用 `lifetime.acquire(factory)`。声明一个依赖后通过 `context.dependencies.alias` 使用它，避免运行时动态查找隐藏依赖。

监听与贡献默认属于当前 Instance 的 Lifetime。传入 `{ lifetime: child }` 可将其归属子树。归属选项必须是普通数据对象，出现未知字段或访问器会在登记前报错。候选 Instance 可以登记监听和贡献，但直到整笔执行提交后才可被外部观察到。候选 setup 内调用 `events.emit` 会失败，应在提交后的业务操作中发出事件。在两次 Host 变更之间添加或移除贡献时，贡献列表与所属 Lifetime 的发布计数都会先更新，再通知两个视图的订阅者。

Event 监听器可以同步返回，也可以返回 Promise。`events.emit` 跳过 Lifetime 已封闭入口的监听器，等待所有已调用的监听器结束，并汇总它们的错误。每个调用在完成前借用监听器的 Lifetime，因此异步处理不会脱离所有权。需要独立于本次广播持续运行的后台工作时，显式使用 `lifetime.spawn`，由 Task 拥有错误报告。需要先中断才能结束的资源使用 `lifetime.interrupt`。

配置是数据：普通对象、数组、字符串、有限数字、布尔值与 null。捕获时拒绝 getter、原型对象、循环、函数、symbol 和稀疏数组；validator 的输出也再次捕获。schema 只在 plan 阶段执行一次，apply 使用已经验证的计划结果。

## 向文档与代理公开声明

```ts
const description = describePlugin(plugin);
const serialized = JSON.stringify(description);
```

`describePlugin` 从 requires/provides 直接提取别名和契约身份。示例 05 在第一次 setup 之前生成 JSON 描述，并明确显示只有 validate 的配置 schema 状态为 unavailable。支持 Standard JSON Schema 1.1 的 schema 可以给出 input/output JSON Schema；导出不会调用验证器或尝试运行插件。描述应在可信的本地声明或构建过程中生成，外部代码的 import 仍需经过 Platform 准入。
