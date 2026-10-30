# Dougong

[简体中文](./README.md) · English

A TypeScript plugin composition kernel with immutable plans, atomic publication, owned resource lifetimes and structured inspection.

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

## Packages

| Package | Responsibility |
| --- | --- |
| `dougong` | Contracts, Plugin, Plan, Host and Lifetime |
| `dougong/advanced` | Public composition primitives for downstream adapters |
| `@dougongjs/platform` | Artifact catalog, selection, admission and activation |
| `@dougongjs/reactive` | Independent signals, Readable bridge and owned observation |

The kernel has one mutation path: `host.change()` → `host.plan(change)` → `host.apply(plan)`. Start and stop use the same execution model. Services and executable contributions are borrowed for the duration of calls. Standard disposable resources belong to a Lifetime. Failed cleanup retains unresolved obligations and quarantines execution.

## Development

```sh
pnpm install
pnpm check
pnpm examples
pnpm docs:dev
```

Runtime: Node.js 22+, Chrome/Edge 119+, Firefox 121+, Safari 17.4+. Development: Node.js 22.12+, 24 or 26+; use the pinned pnpm version. Published packages are ESM.

[Documentation](https://tangerg.github.io/dougong/en/) · [Architecture](./docs/en/reference/architecture.md) · [Examples](./docs/en/examples.md) · [Contributing rules](./AGENTS.md)

MIT License.
