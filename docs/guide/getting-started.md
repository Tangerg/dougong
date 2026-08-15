# 快速开始

本页用十分钟带你装上 Dougong、写出第一个能力组合，并理解它和普通 DI 容器的关键区别。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22 |
| JavaScript 宿主 | 需提供 ES2024 标准能力，包括 `Promise.withResolvers()` |
| TypeScript | ≥ 5.5（如果使用 TypeScript） |

::: warning 浏览器 / WebView 宿主
`Promise.withResolvers()` 需要 Safari 17.4+（macOS 14.4+）、Chrome 119+、Firefox 121+。
如果你在 Electron、Tauri 或 Wails 里使用系统 WebView，请先确认目标系统版本。
:::

## 安装

```sh
npm install dougong
```

`dougong` 是门面包，它 re-export 三个实包。如果你只需要内核，也可以单独安装：

```sh
npm install @dougongjs/core       # 六个原子、依赖图、事务、诊断
npm install @dougongjs/reactive   # Signal 值层与 observe（零依赖）
npm install @dougongjs/platform   # Manifest、权限、懒激活、HMR
```

### TypeScript 配置

Dougong 的类型使用 `Symbol.dispose` 和 `AbortSignal`，你的 `tsconfig.json` 必须包含对应的 lib：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"],
    "moduleResolution": "Bundler",
    "strict": true
  }
}
```

::: danger 少了会怎样
只写 `"lib": ["ES2024"]` 会得到一串指向 `node_modules` 的报错，看起来像库坏了：

```
Property 'dispose' does not exist on type 'SymbolConstructor'
Cannot find name 'AbortSignal'
```

补上 `DOM` 和 `ESNext.Disposable` 即可。
:::

## 第一个能力组合

下面是一个完整可运行的例子。provider 发布一个稳定 Service，consumer 通过 `requires` 声明依赖。

```ts
import { createApp, definePlugin, service } from "dougong"

interface Clock {
  now(): Date
}

interface Greeter {
  greet(name: string): string
}

// 1. Contract 是一个冻结的身份令牌，把类型和字符串 ID 绑在一起
const CLOCK = service<Clock>("example/clock")
const GREETER = service<Greeter>("example/greeter")

// 2. provider：在 provides 里声明，从 setup 返回实现
const clock = definePlugin({
  name: "example.clock",
  provides: { clock: CLOCK },
  setup: () => ({ clock: { now: () => new Date() } }),
})

// 3. consumer：在 requires 里声明，从 ctx 读取
const greeter = definePlugin({
  name: "example.greeter",
  requires: { clock: CLOCK },
  provides: { greeter: GREETER },
  setup: (ctx) => ({
    greeter: {
      greet: (name) => `${ctx.clock.now().toISOString()} Hello, ${name}`,
    },
  }),
})

const app = createApp({ name: "hello" })
app.install(greeter)   // 注意：先装 consumer
app.install(clock)     // 后装 provider —— 顺序无所谓

await app.start()
console.log(app.get(GREETER).greet("Dougong"))
await app.stop()
```

运行输出：

```text
2026-08-15T00:00:00.000Z Hello, Dougong
```

## 这段代码里发生了什么

### 安装顺序不是启动顺序

`greeter` 先安装，但它依赖 `clock`。`app.start()` 时 Dougong 从 `requires` / `provides` 的声明构建依赖图，做拓扑排序，**同一拓扑层内并发启动**，然后按逆依赖顺序停止。

你不需要手工排序，也不需要 `dependsOn: ["example.clock"]` 这种字符串数组——依赖关系已经在类型里了。

### 插件只能读它声明过的依赖

```ts
definePlugin({
  name: "bad",
  setup(ctx) {
    ctx.clock.now()   // ❌ 编译错误
  },                  //    Property 'clock' does not exist on type 'PluginContext<{}>'
})
```

`ctx` 的类型是从 `requires` 推导出来的。没声明就没有这个属性——这是**编译期**错误，不是运行时的 `undefined`。

这条是 Dougong 和大多数插件框架最实际的区别。在依赖靠字符串或环境上下文解析的系统里，忘记声明依赖通常表现为「有时候能跑、有时候拿到 undefined」，取决于加载顺序。

### `app.get()` 是给宿主用的，不是给插件用的

```ts
app.get(GREETER)     // ✓ 宿主跨越运行时边界读取能力
ctx.get(GREETER)     // ✗ 不存在这个方法
```

插件之间通过 `requires` 建立关系，这样依赖图才是完整的。如果插件能随时用 Service Locator 拿任意能力，依赖图就不再反映真实依赖，拓扑排序和事务回滚都会失去意义。

`app.get()` 只在 `status === "active"` 时可用，否则抛 `SERVICE_UNAVAILABLE`。

## 运行仓库示例

如果你想直接看更完整的场景：

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong
pnpm install
pnpm examples        # 依次运行九个示例
pnpm check           # 完整验证门禁
pnpm docs:dev        # 本地启动这个文档站
```

十二章示例分三段递进——原子、组合、真实宿主——从最小 Service 一路走到 Planet / Lynx 场景、声明式计划和模块图 HMR，全部进 CI。详见[可执行示例](../examples.md)。

## 接下来

- **想理解模型** → [核心概念](./concepts.md)：六个原子各自解决什么，为什么 Extension 不能用 Service 替代
- **想直接写代码** → [编写插件](./writing-plugins.md)：配置校验、可选依赖、失败处理
- **关心资源泄漏** → [生命周期与资源](./lifetime.md)
- **需要精确语义** → [Core API 规范](../reference/core-api.md)
