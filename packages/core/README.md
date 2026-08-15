# @dougongjs/core

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

Dougong 的能力组合与结构化生命周期内核。

```sh
npm install @dougongjs/core
```

### 六个原子

- **`Service`** —— 稳定的一对一能力。依赖通过 `requires` 显式声明，Instance 生命周期内不变；提供者变化会重建消费者，不使用 live Proxy。
- **`ExtensionPoint`** —— 可动态增删的开放贡献集合。Core 只保存原始贡献；排序、领域 key、覆盖和 pipeline 是高层组合策略。
- **`Event`** —— 不保留状态的瞬时事实。只有一种分发语义：并发广播并等待全部监听器。
- **`Lifetime`** —— 监听、贡献、任务、子生命周期与清理的结构化所有权。终态资源自动从父级摘除。
- **`Plugin`** —— 一次 `setup` 产生一组能力。
- **`Host`** / **`ChangeSet`** —— 事务化的安装图；失败回滚，无法可靠回滚时 fail closed。

```ts
import { createHost, definePlugin, service } from "@dougongjs/core"

const DATABASE = service<Database>("app/database")

const database = definePlugin({
  name: "app.database",
  provides: { db: DATABASE },
  async setup(ctx) {
    const client = await connect()
    ctx.cleanup(() => client.close())
    return { db: client }
  },
})

const host = createHost({ name: "api" })
host.install(database)
await host.start()
```

不使用 Service Locator、环境作用域、原型链注入或 Proxy。运行时依赖只有 `@standard-schema/spec`（类型契约）。

### 环境要求

Node.js ≥ 22 或等价的 ES2024 运行时。TypeScript 消费者需要
`"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]`。

---

## English

The capability composition and structured lifetime kernel of Dougong.

```sh
npm install @dougongjs/core
```

### Six atoms

- **`Service`** — a stable one-to-one capability. Dependencies are declared explicitly through `requires` and stay fixed for the Instance lifetime; a provider change rebuilds consumers rather than using a live proxy.
- **`ExtensionPoint`** — an open contribution set that adds and removes live. Core keeps only raw contributions; ordering, domain keys, override and pipelines are higher-level composition policy.
- **`Event`** — a transient fact retaining no state, with one dispatch semantic: broadcast concurrently and await every listener.
- **`Lifetime`** — structured ownership of listeners, contributions, tasks, child lifetimes and cleanups. Terminal resources detach from their parent automatically.
- **`Plugin`** — one `setup` producing a set of capabilities.
- **`Host`** / **`ChangeSet`** — a transactional installation graph; a failure rolls back, and fails closed when it cannot roll back reliably.

```ts
import { createHost, definePlugin, service } from "@dougongjs/core"

const DATABASE = service<Database>("app/database")

const database = definePlugin({
  name: "app.database",
  provides: { db: DATABASE },
  async setup(ctx) {
    const client = await connect()
    ctx.cleanup(() => client.close())
    return { db: client }
  },
})

const host = createHost({ name: "api" })
host.install(database)
await host.start()
```

No service locator, ambient scope, prototype-chain injection or proxy. The only runtime dependency is `@standard-schema/spec` (a type contract).

### Requirements

Node.js ≥ 22 or an equivalent ES2024 runtime. TypeScript consumers need
`"lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"]`.

---

- 文档站 / Documentation: https://tangerg.github.io/dougong/
- 仓库 / Repository: https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。
> Early development (0.0.x); no backward-compatibility promises yet.

MIT
