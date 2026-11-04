# Dougong

[简体中文](./README.md) · English

A TypeScript plugin composition kernel with immutable plans, atomic publication, owned resource lifetimes and structured inspection.

Upgrading from 0.8.3? Read the [migration guide](./docs/en/guide/migrating-to-0.9.md) and [0.9.0 release notes](./docs/en/reference/release-0.9.0.md).

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
const { value: message } = await host.use(GREETER, (service) => service.greet("Dougong"));
await host[asyncDisposeSymbol]();
```

## Packages

| Package | Responsibility |
| --- | --- |
| `dougong` | Contracts, Plugin, Plan, Host and Lifetime |
| `dougong/advanced` | Public composition primitives for downstream adapters |
| `@dougongjs/platform` | Artifact catalog, selection, admission and activation |
| `@dougongjs/reactive` | Independent signals, Readable bridge and owned observation |

The kernel has one mutation path: `host.change()` → `host.plan(change)` → `host.apply(plan)`. Start and stop use the same execution model. Services and executable contributions are borrowed for the duration of calls. Standard disposable resources belong to a Lifetime. Failed cleanup retains consumers and their dependencies, releases independent branches, and makes the whole Host permanently unavailable. Quarantine has no in-place recovery; replacement requires handling the old execution boundary and external resources. See [Application handling after quarantine](./docs/en/guide/transactions.md#quarantine).

## Development

```sh
pnpm install
pnpm check
pnpm examples
pnpm docs:dev
```

Runtime and development: <!-- runtime-baseline:start -->Node.js `^24.22.0 || >=26.10.0`, Chrome ≥ 119, Edge ≥ 119, Firefox ≥ 124, Safari ≥ 17.4<!-- runtime-baseline:end -->. Use the pinned pnpm version. Published packages are ESM.

[Documentation](https://tangerg.github.io/dougong/en/) · [Architecture](./docs/en/reference/architecture.md) · [Examples](./docs/en/examples.md) · [Contributing rules](./AGENTS.md)

MIT License.
