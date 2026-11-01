# 快速开始

Dougong 是 TypeScript 的插件装配与资源生命周期内核。安装主包即可使用契约、插件、显式计划、Host 和 Lifetime。

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

Service 的字符串 ID 是共享身份；其 TypeScript 类型描述值协议。Plugin 是可重复安装的声明，Installation 是带有稳定 ID 的安装位置，Instance 是一次执行产生的运行代次。应用通过 `host.use` 借用当前代次，回调返回的 Promise 完成后释放借用。

运行时支持 Node.js 22+，以及 Chrome 119、Edge 119、Firefox 124、Safari 17.4 及以上。发行物是 ESM，释放协议使用标准 `Symbol.dispose` 与 `Symbol.asyncDispose`。源码开发要求 Node.js 22.12+、24 或 26+，使用仓库固定的 pnpm 版本。

需要外部插件交付时添加 `@dougongjs/platform`；需要信号、观察与跨副本桥接时添加 `@dougongjs/reactive`。两个能力按需导入。

下一步阅读[核心概念](./concepts.md)和[编写插件](./writing-plugins.md)。

TypeScript 配置需要 `ES2024`、`DOM` 与 `ESNext.Disposable` 的 lib 定义；发行类型同时支持 Bundler 与 NodeNext 模块解析。

需要显式释放且运行时没有内建释放符号时，从 `dougong` 导入 `disposeSymbol` 或 `asyncDisposeSymbol` 作为键，例如 `await host[asyncDisposeSymbol]()`。包与适配器使用同一套键，不会修改全局 Symbol。

## 浏览器原生 ESM

Vite 等打包工具会按包声明选择浏览器实现。自行托管原生模块时，把发行包里的 `dist/` 和 `runtime/` 放在同一个包目录下，在第一个模块脚本之前添加 import map。以下示例将主包放在 `/vendor/dougong/`。

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

若同时托管 `@dougongjs/reactive`，为它的包目录添加同样的 scope，指向该副本的 `runtime/abort-listener.web.mjs`。
