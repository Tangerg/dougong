# @dougongjs/platform

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

外部插件分发层：Manifest 校验、权限授权、模块加载、懒激活与热更新。

```sh
npm install @dougongjs/platform
```

```ts
import { createHost } from "@dougongjs/core"
import { createPlatform, ImportLoader, PermissionSet, defineManifest } from "@dougongjs/platform"

const host = createHost({ name: "editor" })
await host.start()

const platform = createPlatform({
  installer: host,                    // 编译目标：Host 或 Group
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  authorizer: new PermissionSet(["fs:read"]),
})

await platform.register({
  manifest: defineManifest({
    name: "acme.markdown",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["onLanguage:markdown"],
    permissions: ["fs:read"],
  }),
  reference: "https://cdn.example.com/acme-markdown.js",
})

await platform.trigger("onLanguage:markdown")
```

它把这四个外部关注点——**声明**（Manifest）、**加载**（Loader）、**授权**（Permissions）、**激活**（Activation）——**编译成一份** canonical Core `ChangeSet`，不复制注册表、依赖图、事务、资源所有权、观察协议或错误语义。

**注册 ≠ 激活。** `register()` 只让 Artifact 进入 Platform，`activate()` 才加载外部 Plugin。可选的 `placeholder`（应用代码编写的 Plugin）让「命令已在菜单里，点击时才加载」成为可能，且两者替换是原子的。

> ⚠️ 权限是**策略端口，不是沙箱**。它决定「要不要运行这段代码」，不决定「这段代码能碰什么」。真正的隔离需要 Worker、iframe、进程或独立 Host。

---

## English

The external plugin delivery layer: manifest validation, permission authorization, module loading, lazy activation and hot reload.

```sh
npm install @dougongjs/platform
```

```ts
import { createHost } from "@dougongjs/core"
import { createPlatform, ImportLoader, PermissionSet, defineManifest } from "@dougongjs/platform"

const host = createHost({ name: "editor" })
await host.start()

const platform = createPlatform({
  installer: host,                    // compilation target: a Host or a Group
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  authorizer: new PermissionSet(["fs:read"]),
})

await platform.register({
  manifest: defineManifest({
    name: "acme.markdown",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["onLanguage:markdown"],
    permissions: ["fs:read"],
  }),
  reference: "https://cdn.example.com/acme-markdown.js",
})

await platform.trigger("onLanguage:markdown")
```

It compiles four external concerns — **declaration** (manifest), **loading** (loader), **authorization** (permissions) and **activation** — into one canonical Core `ChangeSet`, duplicating none of Core's registries, dependency graph, transactions, resource ownership, observation protocol or error semantics.

**Registration ≠ activation.** `register()` only admits the artifact; `activate()` loads the external implementation. An optional application-authored `placeholder` makes "the command is already in the menu but loads on click" possible, and the swap from placeholder to real implementation is atomic.

> ⚠️ Permissions are a **policy port, not a sandbox**. They decide whether to run the code, not what the code may touch. Real isolation needs a Worker, iframe, process or separate Host.

---

- 文档站 / Documentation: https://tangerg.github.io/dougong/
- 仓库 / Repository: https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。需要 Node.js ≥ 22，或 Chrome / Edge 119、Firefox 121、Safari 17.4 及以上浏览器 / WebView。
> Early development (0.0.x); no backward-compatibility promises yet. Requires Node.js ≥ 22, or Chrome / Edge 119, Firefox 121 or Safari 17.4 and later.

MIT
