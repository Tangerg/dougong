---
layout: home
title: Dougong
titleTemplate: false
description: 纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。
hero:
  name: Dougong
  text: 组合出应用，而不是堆叠框架
  tagline: 用少量正交的原子组织能力、依赖、变化与资源所有权。零运行时魔法。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 核心概念
      link: /guide/concepts
    - theme: alt
      text: GitHub
      link: https://github.com/Tangerg/dougong
features:
  - title: 显式优于隐式
    details: 依赖写在 requires，身份写在 Contract，所有权写在 Lifetime。没有 Service Locator、环境作用域、原型链注入或 Proxy——ctx.foo 的来源永远在同一个文件里看得见。
  - title: 一种语义，一条路径
    details: 每个语义操作只有一个正式入口。高层便利 API 必须机械展开到它，不能拥有第二套状态机。
  - title: 事务只暴露已提交状态
    details: setup 期间的声明先暂存，整层校验通过才发布。失败回滚旧图，无法可靠回滚时 fail closed，不会留下半装好的运行时。
  - title: 结构化资源所有权
    details: 监听、贡献、任务、子生命周期都归属于某个 Lifetime。终态资源自动从父级摘除，保留一个已释放的 Handle 不会反向保活整个 Application。
  - title: 类型即约束
    details: 用未声明的依赖、把 Extension 当 Service 取、声明了 provides 却不返回——全部是编译错误，不是运行时惊喜。
  - title: 不绑定宿主
    details: Core 不理解 Node、DOM、React、HTTP、文件系统或打包器。只用普通对象、函数、Promise、AbortSignal 和 Disposable。
---

## Dougong 是什么

Dougong（斗拱）解决一个具体问题：**当一个应用的能力需要被拆成可独立装卸的单元时，如何让它们之间的依赖、生命周期和变更保持可推理。**

它由两层组成：

- **Core** —— 能力组合与结构化生命周期内核。六个原子：Service、Extension、Event、Lifetime、Plugin、Application。
- **Platform** —— 建立在 Core 之上的外部插件分发层。Manifest 校验、权限、模块加载、懒激活、热更新。

外加一个**互不依赖**的 `reactive` 包，提供 Signal 值层和 `observe()` 组合器。

```ts
import { createApp, definePlugin, service } from "dougong"

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

const app = createApp({ name: "hello" })
app.install(greeter)                 // 安装顺序不决定启动顺序
app.install(clock)
await app.start()                    // 从 Service 声明推导拓扑，同层并发启动
```

## 它适合什么

| 适合 | 不适合 |
| --- | --- |
| 能力需要动态装卸、更新、回滚 | 只需要一个简单的 DI 容器 |
| 插件之间有真实依赖关系 | 插件完全独立、互不通信 |
| 半加载状态不可接受，需要事务一致性 | 长驻服务，一个模块坏了其他照跑更重要 |
| 需要向宿主暴露可观察的运行状态 | 不关心运行时诊断 |
| 桌面应用、编辑器内核、构建工具链 | 简单的 Web 页面 |

最后一行值得展开：Dougong 的失败模型是**事务性**的——一个插件 setup 失败会让整笔变更回滚。如果你的场景更需要「一个插件挂了不影响其他」的隔离性，那么 [cordis](https://github.com/cordiverse/cordis) 这类设计更合适。这是产品取舍，不是优劣。

## 学习路径

文档分成三层，建议按顺序：

<div class="vp-doc" style="margin-top: 1rem">

**第一层 · 上手**

1. [快速开始](./guide/getting-started.md) —— 装上、跑通第一个能力组合
2. [核心概念](./guide/concepts.md) —— 六个原子各自解决什么问题，为什么不能互相替代

**第二层 · 深入**

3. [编写插件](./guide/writing-plugins.md) —— 依赖、提供、配置校验、失败处理
4. [生命周期与资源](./guide/lifetime.md) —— 谁拥有什么，什么时候释放
5. [事务与变更](./guide/transactions.md) —— ChangeSet、Group、回滚与 fail closed
6. [响应式与观察](./guide/reactive.md) —— Signal 为什么不是第五种能力
7. [外部插件分发](./guide/platform.md) —— Manifest、权限、懒激活、HMR

**第三层 · 规范**

8. [Core API 规范](./reference/core-api.md) —— 每个 API 的精确语义与边界情形
9. [整体架构](./reference/architecture.md) —— 分层、依赖方向与设计论证
10. [Platform 规范](./reference/platform.md) —— 外部插件边界
11. [错误码](./reference/errors.md) —— 25 个稳定错误码及触发条件

</div>

如果你更喜欢读代码，[可执行示例](./examples.md)是从最小 Service 一路走到 Planet / Lynx / HMR 的九个场景，全部进 CI。

## 状态

Dougong 处于早期开发阶段（`0.0.x`），**当前不承诺向后兼容**。优先保证的是模型正确、API 一致和可执行证据完整。

运行时基线：Node.js ≥ 22，或等价的 ES2024 宿主。
