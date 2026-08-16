<div align="center">

# Dougong

**能力组合与结构化生命周期内核** · 纯 JavaScript/TypeScript

[![npm](https://img.shields.io/npm/v/dougong?color=9f3f2f)](https://www.npmjs.com/package/dougong)
[![license](https://img.shields.io/npm/l/dougong?color=9f3f2f)](./LICENSE)
[![node](https://img.shields.io/node/v/dougong?color=9f3f2f)](https://nodejs.org)

[文档站](https://tangerg.github.io/dougong/) ·
[快速开始](https://tangerg.github.io/dougong/guide/getting-started) ·
[核心概念](https://tangerg.github.io/dougong/guide/concepts) ·
[API 规范](https://tangerg.github.io/dougong/reference/core-api) ·
**简体中文** · [English](./README.en.md)

</div>

---

Dougong（斗拱）解决一个具体问题：**当一个应用的能力需要被拆成可独立装卸的单元时，如何让它们之间的依赖、生命周期和变更保持可推理。**

```sh
npm install dougong
```

```ts
import { createHost, definePlugin, service } from "dougong"

const CLOCK = service<Clock>("app/clock")

const clock = definePlugin({
  name: "app.clock",
  provides: { clock: CLOCK },
  setup: () => ({ clock: { now: () => new Date() } }),
})

const greeter = definePlugin({
  name: "app.greeter",
  requires: { clock: CLOCK },        // 依赖写在这里
  setup(ctx) {
    console.log(ctx.clock.now())     // 只能读声明过的依赖，否则编译错误
  },
})

const host = createHost({ name: "hello" })
host.install(greeter)                 // 安装顺序不决定启动顺序
host.install(clock)
await host.start()                    // 从声明推导拓扑，同层并发启动
```

## 为什么是这样

**显式优于隐式。** 依赖写在 `requires`，身份写在 Contract，所有权写在 Lifetime，调用期选择写在普通参数。没有 Service Locator、环境作用域、原型链注入或 Proxy——`ctx.foo` 的来源永远在同一个文件里看得见。

**一种语义，一条路径。** 每个语义操作只有一个正式入口，高层便利 API 必须机械展开到它，不能拥有第二套状态机。

| 语义 | 正式入口 | | 语义 | 正式入口 |
| --- | --- | --- | --- | --- |
| 安装插件 | `install()` | | 监听 / 发送 Event | `on()` / `emit()` |
| 原子修改安装计划 | `change()` | | 注册资源 | `cleanup()` |
| 发布 Service | `provides` + `setup` 返回值 | | 子生命周期 / 任务 | `lifetime(label)` / `spawn()` |
| 贡献 ExtensionPoint | `contribute()` | | 读取 / 订阅实时值 | `get()` / `subscribe()` |
| 更新 / 删除安装 | `update()` / `remove()` | | 提前释放资源 | `dispose()` |

**事务只暴露已提交状态。** setup 期间的 Contract kind、监听与贡献先暂存，整层校验通过才发布。失败回滚旧图，无法可靠回滚时 fail closed，不会留下半装好的执行图。

**类型即约束。** 用未声明的依赖、把 ExtensionPoint 当 Service 取、声明了 `provides` 却不返回——全部是编译错误。

## 六个原子

```text
Service          稳定的一对一能力，Instance 生命周期内不变，提供者变化则重建消费者
ExtensionPoint   可动态增删的开放贡献集合，变化通知订阅者
Event            不保留状态的瞬时事实，一种分发语义
Lifetime         监听、贡献、任务与资源的结构化所有权，终态自动摘除
Plugin           一次 setup 产生一组能力
Host             依赖图、事务与 Instance 编排
```

Signal 不是第五种能力。`@dougongjs/reactive` 提供 `signal()` / `computed()` / `batch()` 和基于公开 Lifetime 协议的 `observe()`；Core 不依赖它，也不提供隐式 effect。

## 包结构

| 包 | 说明 | 包依赖 |
| --- | --- | --- |
| [`dougong`](./packages/dougong) | 门面，re-export 下面三个 | 三个内部包 |
| [`@dougongjs/core`](./packages/core) | 六个原子、依赖图、事务、Group、诊断 | `@standard-schema/spec` |
| [`@dougongjs/reactive`](./packages/reactive) | Signal 值层与 `observe()` | **无** |
| [`@dougongjs/platform`](./packages/platform) | Manifest、Loader、权限、懒激活、HMR | core、zod、compare-versions |

`core` 与 `reactive` 是互不依赖的基础层；`platform` 只依赖 `core`；`dougong` 只是组合入口。这条方向由 CI 的架构门禁强制。

## 适用场景

| 适合 | 不适合 |
| --- | --- |
| 能力需要动态装卸、更新、回滚 | 只需要一个简单的 DI 容器 |
| 插件之间有真实依赖关系 | 插件完全独立、互不通信 |
| 半加载状态不可接受 | 长驻服务，局部降级比一致性更重要 |
| 桌面应用、编辑器内核、构建工具链 | 简单的 Web 页面 |

Dougong 的失败模型是**事务性**的——一个插件 setup 失败会让整笔变更回滚。如果你更需要「一个插件挂了不影响其他」的隔离性，[cordis](https://github.com/cordiverse/cordis) 这类设计更合适。这是产品取舍，不是优劣。

## 文档

从入门到规范分三层：

**上手** — [快速开始](https://tangerg.github.io/dougong/guide/getting-started) · [核心概念](https://tangerg.github.io/dougong/guide/concepts)

**深入** — [编写插件](https://tangerg.github.io/dougong/guide/writing-plugins) · [生命周期与资源](https://tangerg.github.io/dougong/guide/lifetime) · [事务与变更](https://tangerg.github.io/dougong/guide/transactions) · [响应式与观察](https://tangerg.github.io/dougong/guide/reactive) · [外部插件分发](https://tangerg.github.io/dougong/guide/platform)

**规范** — [Core API 规范](https://tangerg.github.io/dougong/reference/core-api) · [整体架构](https://tangerg.github.io/dougong/reference/architecture) · [Platform 规范](https://tangerg.github.io/dougong/reference/platform) · [错误码](https://tangerg.github.io/dougong/reference/errors)

## 示例

[十二章可执行示例](./packages/examples)分三段由浅入深——原子、组合、完整应用——从最小 Service 走到 Planet / Lynx 场景、声明式计划和模块图 HMR，全部进 CI：

```sh
pnpm examples
```

「每章只增加一个新台阶」不是一句话，而是一条测试：十二章各自声明首次引入的概念，测试把它们首尾相接和教学大纲做全等比较——重复、顺序倒置或原地踏步都会让 CI 变红。

其中第 11、12 章各约 200 行，只用公开 API 实现了成熟框架里动辄上千行的声明式配置加载器和热更新引擎——这是对「Core 抽象是否足够可展开」的检验。

## 环境要求

Node.js ≥ 22；浏览器 / WebView 基线为 Chrome / Edge 119、Firefox 121、Safari 17.4，运行时必须提供 `Promise.withResolvers()`。Dougong 会为释放协议选择稳定的 Symbol key，不会在缺少 `Symbol.dispose` 时静默创建名为 `"undefined"` 的方法；显式 `.dispose()` 在上述基线上始终可用。

`using` / `await using` 还要求运行时原生提供或预先 polyfill `Symbol.dispose` / `Symbol.asyncDispose`；Dougong 不修改全局对象。发布代码本身不要求运行时解析 `using`，TypeScript 5.2+ 或等价编译器可以降级这段语法。

TypeScript 消费者的 `tsconfig.json` 需要：

```json
"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]
```

## 开发

```sh
pnpm install
pnpm check      # 10 步验证门禁
pnpm docs:dev   # 本地文档站
```

`pnpm check` 依次执行：类型检查 → lint → 格式检查 → 测试与覆盖率 → 死代码检查 → 循环依赖检查 → 架构层级检查 → 发布构建 → 公共声明面检查 → 文档构建。

架构约束不只写在文档里。包依赖方向、模块 rank、固定 Contract ID 唯一性、退役词汇，以及一组**反向规则**（例如「Platform 命令串行化必须用 Core 的 `SerialQueue`」——缺了就说明有人另起了一条状态机）都会变成 CI 失败。完整清单见[机械守卫](https://tangerg.github.io/dougong/reference/guards)。

## 状态

早期开发阶段（`0.0.x`），**当前不承诺向后兼容**。优先保证模型正确、API 一致和可执行证据完整。

## 许可证

[MIT](./LICENSE)
