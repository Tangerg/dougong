# Dougong

简体中文 · [English](./README.en.md)

TypeScript 插件装配内核：不可变计划、原子发布、结构化资源生命周期和可解释诊断。

从 0.8.3 升级请先阅读[迁移指南](./docs/guide/migrating-to-0.9.md)和 [0.9.0 Release Notes](./docs/reference/release-0.9.0.md)。

```ts
import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";

const GREETER = service<{ greet(name: string): string }>("application/greeter");
const greeter = definePlugin({
  name: "application.greeter",
  provides: { greeter: GREETER },
  setup() {
    return { greeter: { greet: (name) => `Hello, ${name}` } };
  },
});

const host = createHost({
  name: "application",
  installations: [{ id: "greeter", plugin: greeter }],
});
await host.start();
const message = await host.use(GREETER, (service) => service.greet("Dougong"));
await host[asyncDisposeSymbol]();
```

## 包

| Package | Responsibility |
| --- | --- |
| `dougong` | Contracts, Plugin, Plan, Host and Lifetime |
| `dougong/advanced` | Public composition primitives for downstream adapters |
| `@dougongjs/platform` | Artifact catalog, selection, admission and activation |
| `@dougongjs/reactive` | Independent signals, Readable bridge and owned observation |

内核只有一条变更路径：`host.change()` → `host.plan(change)` → `host.apply(plan)`；start、stop 复用相同执行模型。服务和可执行贡献在调用期间借用，标准资源归 Lifetime 所有。清理失败保留消费者及其依赖，继续释放独立分支，并使整个 Host 终止可用性。隔离没有原地恢复入口；替换 Host 之前必须处理旧执行边界和外部资源，见[隔离后的应用处理](./docs/guide/transactions.md#quarantine)。

## 开发

```sh
pnpm install
pnpm check
pnpm examples
pnpm docs:dev
```

运行环境：Node.js 22+、Chrome/Edge 119+、Firefox 124+、Safari 17.4+。开发环境：Node.js 22.12+、24 或 26+，使用仓库固定的 pnpm。发行包为 ESM。

[文档](https://tangerg.github.io/dougong/) · [架构](./docs/reference/architecture.md) · [示例](./docs/examples.md) · [协作约束](./AGENTS.md)

MIT License。
