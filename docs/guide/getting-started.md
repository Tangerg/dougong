# 快速开始

Dougong 当前处于仓库内开发阶段。最直接的体验方式是运行已经进入测试与构建门禁的示例包。

## 运行仓库

需要 Node.js 22 和仓库声明的 pnpm 版本：

```sh
pnpm install
pnpm check
pnpm examples
```

启动本文档站：

```sh
pnpm docs:dev
```

## 第一个能力组合

下面的 provider 发布稳定 Service，consumer 通过 `requires` 显式声明依赖。安装顺序不决定启动顺序，Application 会从 Service 边构建依赖图。

```ts
import { createApp, definePlugin, service } from "dougong"

interface Clock {
  now(): Date
}

interface Greeter {
  greet(name: string): string
}

const CLOCK = service<Clock>("example/clock")
const GREETER = service<Greeter>("example/greeter")

const clock = definePlugin({
  name: "example.clock",
  provides: { clock: CLOCK },
  setup: () => ({ clock: { now: () => new Date() } })
})

const greeter = definePlugin({
  name: "example.greeter",
  requires: { clock: CLOCK },
  provides: { greeter: GREETER },
  setup: (ctx) => ({
    greeter: {
      greet: (name) => `${ctx.clock.now().toISOString()} Hello, ${name}`
    }
  })
})

const app = createApp({ name: "hello" })
app.install(greeter)
app.install(clock)

await app.start()
console.log(app.get(GREETER).greet("Dougong"))
await app.stop()
```

这里没有 `ctx.get(string)` 或隐式 Service Locator：插件只能读取自己声明过的依赖；`app.get()` 只用于宿主跨越运行时边界。

## 接下来

- [浏览可执行示例](../examples.md)，理解 Extension、Event、Lifetime、Signal、Group 与 Platform 如何组合。
- [阅读 Core API 设计](../api-design.zh-CN.md)，确认每个原子的精确定义。
- [阅读整体架构](../architecture.zh-CN.md)，了解依赖方向和事务发布模型。
