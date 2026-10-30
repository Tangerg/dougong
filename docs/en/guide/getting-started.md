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

Runtime support starts at Node.js 22, Chrome 119, Edge 119, Firefox 121 and Safari 17.4. Packages are ESM and accept the standard `Symbol.dispose` and `Symbol.asyncDispose` resource protocols. Repository development requires Node.js 22.12+, 24 or 26+ and the pinned pnpm version.

Add `@dougongjs/platform` for external plugin delivery. Add `@dougongjs/reactive` for signals, observation and cross-copy bridges. Import each capability from its own package.

Continue with [core concepts](./concepts.md) and [writing plugins](./writing-plugins.md).

TypeScript configuration requires the `ES2024`, `DOM` and `ESNext.Disposable` libraries. Published declarations support both Bundler and NodeNext module resolution.
