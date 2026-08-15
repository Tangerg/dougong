# dougong

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

**能力组合与结构化生命周期内核**，纯 JavaScript/TypeScript。

这是门面包，聚合 [`@dougongjs/core`](https://www.npmjs.com/package/@dougongjs/core)、[`@dougongjs/reactive`](https://www.npmjs.com/package/@dougongjs/reactive) 与 [`@dougongjs/platform`](https://www.npmjs.com/package/@dougongjs/platform)。它只做 re-export，不包含任何逻辑——架构门禁会强制这一点。

```sh
npm install dougong
```

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
await app.start()                    // 从声明推导拓扑，同层并发启动
```

六个原子：**Service**（稳定的一对一能力）、**Extension**（开放贡献集合）、**Event**（瞬时事实）、**Lifetime**（结构化所有权）、**Plugin**、**Application**。

三条核心保证：依赖与所有权**显式**写在声明里；每个语义只有**一条**正式路径；事务只暴露**已提交**状态。

### 环境要求

Node.js ≥ 22 或等价的 ES2024 宿主。TypeScript 消费者需要：

```json
"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]
```

---

## English

A **capability composition and structured lifetime kernel** in pure JavaScript/TypeScript.

This is the facade package aggregating [`@dougongjs/core`](https://www.npmjs.com/package/@dougongjs/core), [`@dougongjs/reactive`](https://www.npmjs.com/package/@dougongjs/reactive) and [`@dougongjs/platform`](https://www.npmjs.com/package/@dougongjs/platform). It only re-exports and contains no logic — an architecture gate enforces that.

```sh
npm install dougong
```

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
  requires: { clock: CLOCK },        // the dependency lives here
  setup(ctx) {
    console.log(ctx.clock.now())     // only declared dependencies exist, or it fails to compile
  },
})

const app = createApp({ name: "hello" })
app.install(greeter)                 // install order does not decide start order
app.install(clock)
await app.start()                    // topology derived from declarations, layers start concurrently
```

Six atoms: **Service** (a stable one-to-one capability), **Extension** (an open contribution set), **Event** (a transient fact), **Lifetime** (structured ownership), **Plugin**, **Application**.

Three core guarantees: dependencies and ownership are written **explicitly** in declarations; every semantic has exactly **one** canonical path; transactions expose only **committed** state.

### Requirements

Node.js ≥ 22 or an equivalent ES2024 host. TypeScript consumers need:

```json
"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]
```

---

- 文档站 / Documentation: https://tangerg.github.io/dougong/
- 仓库 / Repository: https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。
> Early development (0.0.x); no backward-compatibility promises yet.

MIT
