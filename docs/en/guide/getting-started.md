# Getting started

Dougong is a TypeScript kernel for plugin composition and resource lifetimes. Its main package provides contracts, plugins, explicit plans, Host and Lifetime.

```sh
pnpm add dougong
```

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

A Service's string ID is its shared identity; its TypeScript parameter describes the value protocol. A Plugin is a reusable declaration, an Installation is a stable position in the application, and an Instance is one running generation. Application code borrows that generation through `host.use`; the borrow ends when the callback's result settles.

Runtime support starts at Node.js 22, Chrome 119, Edge 119, Firefox 124 and Safari 17.4. Packages are ESM and accept the standard `Symbol.dispose` and `Symbol.asyncDispose` resource protocols. Repository development requires Node.js 22.12+, 24 or 26+ and the pinned pnpm version.

Add `@dougongjs/platform` for external plugin delivery. Add `@dougongjs/reactive` for signals, observation and cross-copy bridges. Import each capability from its own package.

Continue with [core concepts](./concepts.md) and [writing plugins](./writing-plugins.md).

TypeScript configuration requires the `ES2024`, `DOM` and `ESNext.Disposable` libraries. Published declarations support both Bundler and NodeNext module resolution.

For explicit disposal on a runtime without native disposal symbols, import `disposeSymbol` or `asyncDisposeSymbol` from `dougong`, for example `await host[asyncDisposeSymbol]()`. Packages and adapters use these same keys without modifying the global Symbol.

## Native browser modules

Bundlers such as Vite resolve the browser implementation from each package manifest. To serve native modules directly, keep the shipped `dist/` and `runtime/` directories together and place an import map before the first module script. This example serves the main package under `/vendor/dougong/`.

```html
<script type="importmap">
{
  "imports": {
    "dougong": "/vendor/dougong/dist/index.js"
  },
  "scopes": {
    "/vendor/dougong/": {
      "#abort-listener": "/vendor/dougong/runtime/abort-listener.web.mjs"
    }
  }
}
</script>
```

When serving `@dougongjs/reactive` too, give its package directory an equivalent scope pointing to its own `runtime/abort-listener.web.mjs`.
