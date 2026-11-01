# dougong

The TypeScript plugin composition kernel. This package owns contracts, declarations, immutable plans, execution, resource lifetimes and diagnostic projections.

Upgrading from 0.8.3? Read the [migration guide](https://tangerg.github.io/dougong/en/guide/migrating-to-0.9) and [0.9.0 release notes](https://tangerg.github.io/dougong/en/reference/release-0.9.0).

```ts
import { createHost, definePlugin, service } from "dougong";

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
await host[Symbol.asyncDispose]();
```

Use `host.change()`, `host.plan(change)` and `host.apply(plan)` for changes. Services and executable contributions are borrowed with `host.use` and `ContributionView.use`. Standard resources belong to `context.lifetime`; context dependencies live under `context.dependencies`.

Read and observe execution through `host.diagnostics.get()` and `host.diagnostics.subscribe()`. Successful transitions resolve with the state revision and affected installations; failures reject. Cleanup failure retains dependent resources while releasing independently safe branches. It quarantines the whole Host permanently: creating a replacement does not dispose old resources. Follow the [quarantine procedure](https://tangerg.github.io/dougong/en/guide/transactions#quarantine) before takeover.

The formal `dougong/advanced` subpath exports stable snapshot publishing, immutable map snapshots, serial queues and record normalization for downstream composition. Optional delivery and reactivity live in `@dougongjs/platform` and `@dougongjs/reactive`.

ESM; Node.js 22+, Chrome/Edge 119+, Firefox 124+, Safari 17.4+.

[API documentation](https://tangerg.github.io/dougong/en/reference/core-api) · [Architecture](https://tangerg.github.io/dougong/en/reference/architecture)
