# 外部插件分发

到目前为止的插件都是**宿主自己写的**——你 `import` 它，然后 `install`。

`@dougongjs/platform` 处理另一种情况：插件来自**外部**——第三方目录、用户安装的扩展、动态下载的模块。这带来 Core 不该关心的四个问题：

1. 这个模块**声明**了什么（Manifest）
2. 从哪里、什么时候**加载**它（Loader）
3. 允许它做什么（Permissions）
4. 什么时候**激活**它（Activation）

Platform 把这四件事编译成 Core 的操作。它**不复制** Core 的注册表、依赖图、事务、资源所有权、观察协议或错误语义。

## 心智模型

```text
宿主
 └─ PluginPlatform            ← 外部关注点：manifest / loader / 权限 / 激活
      └─ PluginContainer      ← 就是 Core 的 Application
           └─ 已安装的插件
```

Platform 拿一个 `PluginContainer`（Application 或 Group），把外部插件编译成对它的 `install` / `update` / `remove`。

## 最小例子

```ts
import { createApp } from "dougong"
import { createPlatform, ImportPluginLoader, defineManifest } from "dougong"

const app = createApp({ name: "editor" })
await app.start()

const platform = createPlatform({
  container: app,                       // 编译目标
  apiVersion: "1.0.0",                  // 宿主 API 版本
  loader: new ImportPluginLoader(),     // 怎么加载模块
})

const plugin = await platform.register({
  manifest: defineManifest({
    name: "acme.markdown",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["onLanguage:markdown"],
    permissions: ["fs:read"],
  }),
  reference: "https://cdn.example.com/acme-markdown.js",
})

await platform.trigger("onLanguage:markdown")   // 触发激活
```

## Manifest

Manifest 是外部插件的**声明**，在信任边界上被校验和冻结：

```ts
interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly apiVersion: string                        // 对宿主 API 的要求
  readonly activation: ReadonlyArray<string>         // 激活事件
  readonly permissions: ReadonlyArray<string>
  readonly dependencies: Readonly<Record<string, string>>
}
```

`defineManifest()` 会补齐可选字段、校验形状并冻结结果。非法 manifest 抛 `MANIFEST_INVALID`——**在加载任何模块代码之前**。

`apiVersion` 不匹配抛 `API_INCOMPATIBLE`。这是宿主和外部插件之间唯一的兼容性契约。

## Loader 是执行边界

```ts
interface PluginLoader<Reference> {
  load(reference: Reference, signal: AbortSignal): Promise<unknown>
}
```

`Reference` 是泛型——它可以是 URL、文件路径、模块 ID、blob，任何你的宿主能解析的东西。Platform 不关心。

内置两个实现：

```ts
new ImportPluginLoader()        // 动态 import()，Reference 是 string | URL
new MemoryPluginLoader(map)     // 从 Map 取，测试用
```

Loader 是**唯一**执行外部代码的地方。加载失败抛 `MODULE_LOAD_FAILED`，模块形状不对（没有导出合法的插件定义）抛 `MODULE_INVALID`。

`signal` 让加载可以被取消——移除一个正在加载的插件不会留下一个孤儿 import。

## 权限是策略端口，不是沙箱

```ts
import { PermissionSet } from "dougong"

const platform = createPlatform({
  container: app,
  apiVersion: "1.0.0",
  loader: new ImportPluginLoader(),
  permissions: new PermissionSet(["fs:read", "net:fetch"]),
})
```

也可以给一个自定义授权器（比如弹窗问用户）：

```ts
const permissions = {
  async authorize(manifest, signal) {
    const granted = await askUser(manifest.name, manifest.permissions)
    if (!granted) throw new PermissionDeniedError(manifest.name, manifest.permissions)
  },
}
```

::: danger 它不是沙箱
权限检查发生在**执行模块之前**，它决定的是「要不要运行这段代码」，不是「这段代码能碰什么」。

JavaScript 模块一旦被 `import` 就和宿主在同一个 realm 里，能访问同样的全局对象。真正的隔离需要 Worker、iframe、进程或独立 Application——Platform 不假装提供它。

授权会在模块执行**紧邻之前**重新检查一次，所以撤销权限对尚未激活的插件立即生效。
:::

## 注册、占位与懒激活

外部插件通常不该在启动时全部加载。Platform 的模型是**注册 ≠ 激活**：

```ts
const plugin = await platform.register({
  manifest,
  reference: "./heavy-plugin.js",
  placeholder: lightweightStub,     // 可选：激活前对外提供的宿主定义
})

plugin.status      // "registered" → 尚未加载
await plugin.activate()             // 显式激活
plugin.status      // "active"
```

`placeholder` 是一个**宿主编写**的插件定义，在真实模块激活之前占位。它让「命令已经在菜单里，但点击时才加载实现」这类体验成为可能——而且占位到真实实现的替换是**原子**的，走同一笔 Core ChangeSet。

激活也可以由事件触发：

```ts
// manifest.activation: ["onLanguage:markdown", "onCommand:acme.format"]
await platform.trigger("onLanguage:markdown")
```

`trigger()` 会激活所有声明了该事件的插件，**并发**执行，独立失败被聚合成 `AggregateError`——一个插件激活失败不影响其他插件。

## Manifest 依赖

外部插件之间可以声明依赖：

```ts
defineManifest({
  name: "acme.theme-dark",
  dependencies: { "acme.theme-base": "^2.0.0" },
})
```

Platform 会在激活前按依赖顺序激活它们，并检查：

| 错误码 | 条件 |
| --- | --- |
| `PLUGIN_DEPENDENCY_MISSING` | 依赖未注册 |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | 版本范围不满足 |
| `PLUGIN_DEPENDENCY_INACTIVE` | 依赖未能激活 |
| `PLUGIN_CYCLE` | manifest 依赖成环 |
| `PLUGIN_DUPLICATE` | 同名插件重复注册 |

::: tip 两张图，各管各的
Manifest 依赖（外部插件之间的**分发**关系）和 Core 的 Service 依赖（能力之间的**运行**关系）是两张独立的图。

Manifest 依赖决定「先加载谁」，Service 依赖决定「先启动谁」。Platform 不把前者塞进后者。
:::

## Platform ChangeSet

和 Core 一样，多个外部插件的变更走一笔事务：

```ts
const changes = platform.change()
changes.register(newPlugin)
changes.update(existing, nextArtifact)
changes.remove(deprecated)
await changes.commit()
```

它会依次：等待相关插件的在途操作结束 → 授权全部 manifest → 校验候选依赖图 → 加载模块 → **编译成一笔 Core ChangeSet** → 提交。

任何一步失败，Core 那边一动没动。

更新时会检查身份：新 artifact 的 manifest 名字必须和原插件一致，否则 `PLUGIN_IDENTITY`。这保证「更新」不会偷偷变成「换成另一个插件」。

## 热更新

`update()` 保持实例身份，换实现：

```ts
await plugin.update({
  manifest: nextManifest,
  reference: "./plugin@1.3.0.js",
})
```

底层走的是 Core 的 `handle.update({ plugin })`，所以只有受影响的依赖闭包会重启。宿主想做真正的 HMR（监听文件变化、计算失效传播、批量重载），可以在这之上组合——[示例 12](../examples.md#stage-3) 演示了一个约 200 行的完整模块图 HMR。

## 诊断

```ts
platform.diagnostics.get()
// { apiVersion, status, plugins: ReadonlyMap<string, ManagedPluginSnapshot> }

platform.diagnostics.subscribe(() => render())
```

和 Core 用的是**同一个** `get` / `subscribe` 协议——Platform 的诊断内部就是编译到 Core 的 `SnapshotPublisher`，不是另一套实现。架构门禁会强制这一点。

## 释放

```ts
await platform.dispose()
// 或
await using platform = createPlatform({ ... })
```

释放会取消在途激活、从 Core 移除全部已安装的句柄、关闭诊断。之后任何 Platform 方法抛 `PLATFORM_UNAVAILABLE`。

## 接下来

- [Platform 规范](../reference/platform.md) —— 精确语义与边界情形
- [错误码](../reference/errors.md) —— 全部 25 个稳定错误码
- [可执行示例 08 / 12](../examples.md) —— 懒激活与模块图 HMR 的完整场景
