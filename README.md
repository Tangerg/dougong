# Dougong

简体中文 · [English](./README.en.md)

TypeScript 插件装配内核：不可变计划、原子发布、结构化资源生命周期和可解释诊断。

```ts
import { createHost, definePlugin, service } from "dougong";

const GREETER = service<{ greet(name: string): string }>("app/greeter");
const greeter = definePlugin({
  name: "app.greeter",
  provides: { greeter: GREETER },
  setup() {
    return { greeter: { greet: (name) => `Hello, ${name}` } };
  },
});

const host = createHost({
  name: "app",
  installations: [{ id: "greeter", plugin: greeter }],
});
await host.start();
const message = await host.use(GREETER, (service) => service.greet("Dougong"));
await host[Symbol.asyncDispose]();
```

## 包

| Package | Responsibility |
| --- | --- |
| `dougong` | Contracts, Plugin, Plan, Host and Lifetime |
| `dougong/advanced` | Public composition primitives for downstream adapters |
| `@dougongjs/platform` | Artifact catalog, selection, admission and activation |
| `@dougongjs/reactive` | Independent signals, Readable bridge and owned observation |

内核只有一条变更路径：`host.change()` → `host.plan(change)` → `host.apply(plan)`；start、stop 复用相同执行模型。服务和可执行贡献在调用期间借用，标准资源归 Lifetime 所有。清理失败保留未完成义务并隔离执行。

## 开发

```sh
pnpm install
pnpm check
pnpm examples
pnpm docs:dev
```

运行环境：Node.js 22+、Chrome/Edge 119+、Firefox 121+、Safari 17.4+。开发环境：Node.js 22.12+、24 或 26+，使用仓库固定的 pnpm。发行包为 ESM。

[文档](https://tangerg.github.io/dougong/) · [架构](./docs/reference/architecture.md) · [示例](./docs/examples.md) · [协作约束](./AGENTS.md)

MIT License。
