# 错误码

Dougong 的所有结构化错误都带一个稳定的 `code` 字符串。应用代码应该 `switch (error.code)` 分流，而不是匹配消息文本——消息会变，`code` 不会。

## 命名规则

错误码指向**哪个对象的不变量被违反**，而不是笼统地说「插件出错了」：

| 前缀 | 违反不变量的对象 | 属于 |
| --- | --- | --- |
| `SERVICE_*` / `CONTRACT_*` / `CONFIG_*` | Contract 身份、依赖图、配置声明 | Core |
| `INSTALLATION_*` | 一次已存在的安装 | Core |
| `GROUP_*` | 一棵安装所有权子树 | Core |
| `PLUGIN_*` | Plugin 声明本身，或 Manifest 声明的插件依赖关系 | Platform |
| `ARTIFACT_*` | 一份外部制品内部不自洽 | Platform |
| `REGISTRATION_*` | 一条已存在的注册记录 | Platform |
| `MANIFEST_*` / `MODULE_*` / `API_*` / `PERMISSION_*` / `PLATFORM_*` | 信任边界与加载边界 | Platform |

所以看到 `INSTALLATION_REMOVED` 就知道是 Core 的一次安装，看到 `REGISTRATION_REMOVED` 就知道是 Platform 的一条注册——不用点进实现确认层级。

## 错误类型

```ts
class DougongError extends Error {
  readonly code: string
}

class ConfigValidationError extends DougongError {   // code: "CONFIG_INVALID"
  readonly issues: ReadonlyArray<ValidationIssue>
}

class PlatformError extends DougongError {}

class PermissionDeniedError extends PlatformError {  // code: "PERMISSION_DENIED"
  readonly plugin: string
  readonly denied: ReadonlyArray<string>
}
```

多个失败会被聚合成标准的 `AggregateError`，每一条原因都保留在 `errors` 数组里。

::: tip TypeError 与 Error 的分工
除了带 `code` 的错误，Dougong 还用两种原生类型：

- **`TypeError`** —— 调用者传错了东西（不是函数、不是 Contract、key 冲突、在已释放的对象上操作）
- **`Error`** —— 内部不变量被违反，属于框架 bug，正常使用碰不到

所以你可以按构造函数分流：`DougongError` 是可预期的运行时失败，`TypeError` 是你的用法问题。
:::

## Core（`@dougongjs/core`）

### 构图期

这些错误在**任何插件启动之前**抛出。运行图一动没动。

| Code | 触发条件 |
| --- | --- |
| `SERVICE_CYCLE` | 依赖成环。消息带真实环路径：`app.a:1 -> app.b:2 -> app.a:1`。插件 `requires` 自己 `provides` 的 Service 也算 |
| `SERVICE_CONFLICT` | 两个插件提供同一个 Service |
| `SERVICE_MISSING` | 必需 Service 没有提供者（`optional()` 声明的不算） |
| `CONTRACT_CONFLICT` | 同一个 Contract ID 被当作两种 kind 使用 |
| `CONFIG_INVALID` | 配置未通过 Standard Schema。`error.issues` 是逐字段的问题列表 |

::: warning 校验先于停机
所有受影响插件的配置会在停止任何运行中实例之前全部校验完毕。一个拼错的字段不会让应用停在半路。
:::

### 启动与运行期

| Code | 触发条件 |
| --- | --- |
| `SERVICE_NOT_RETURNED` | `provides` 声明了某个 key，但 `setup` 的返回值里没有 |
| `SERVICE_UNAVAILABLE` | `host.get()` 在非 `active` 状态调用；或依赖的 Service 所属安装未处于活动状态 |
| `INSTALLATION_UNAVAILABLE` | 安装处于 `failed` 状态；或 setup 抛出了**非 Error** 的值（原值在 `cause` 里）；或在未提交的 draft 上操作 |
| `INSTALLATION_REMOVED` | 在已移除的 Installation 上操作 |
| `INSTALLATION_IDENTITY` | `update()` 试图更换 Plugin 名称。更新可以换实现和配置，不能换身份 |

### Group

| Code | 触发条件 |
| --- | --- |
| `GROUP_REMOVED` | 在已移除的 Group 上操作 |
| `GROUP_UNAVAILABLE` | Group 尚未成功建立；或 Group 操作失败时抛出的是非 Error 值 |

## Platform（`@dougongjs/platform`）

### 信任边界

在加载任何外部模块代码**之前**抛出。

| Code | 触发条件 |
| --- | --- |
| `MANIFEST_INVALID` | Manifest 形状非法，或声明了重复的激活事件 / 权限 / 依赖 |
| `API_INCOMPATIBLE` | 插件要求的 `apiVersion` 不满足应用版本 |
| `PERMISSION_DENIED` | Authorizer 拒绝。`error.denied` 是被拒的权限列表 |
| `PLUGIN_DUPLICATE` | 同一个 Plugin 名称被两份 Artifact 声明 |

### Manifest 依赖解析

这几条描述的是 Manifest 里**声明的插件依赖关系**，所以仍属于 `PLUGIN_*`。

| Code | 触发条件 |
| --- | --- |
| `PLUGIN_DEPENDENCY_MISSING` | Manifest 依赖的插件未注册 |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | 依赖已注册但版本范围不满足 |
| `PLUGIN_DEPENDENCY_INACTIVE` | 依赖存在但未能激活 |
| `PLUGIN_CYCLE` | Manifest 依赖成环。消息带真实环路径 |

### 加载与激活

| Code | 触发条件 |
| --- | --- |
| `MODULE_LOAD_FAILED` | Loader 抛异常。原始错误在 `cause` 里 |
| `MODULE_INVALID` | 模块加载成功但没有导出合法的 Plugin |
| `ARTIFACT_IDENTITY` | 同一份 Artifact 内部不自洽：Manifest 名称与 placeholder 或加载出的 Plugin 名称不一致 |
| `REGISTRATION_BUSY` | 该 Registration 有一笔变更正在进行中 |
| `REGISTRATION_UNAVAILABLE` | Registration 不可用，或在未提交的注册上操作 |
| `REGISTRATION_REMOVED` | 在已移除的 Registration 上操作 |
| `REGISTRATION_IDENTITY` | 更新 Registration 时，新 Artifact 的 Manifest 名称与原名称不同 |
| `PLATFORM_UNAVAILABLE` | Platform 已释放，或处于不允许该操作的状态 |

::: tip 三种 IDENTITY 的区别
它们描述的是三个不同对象的身份不变量：

- **`INSTALLATION_IDENTITY`** —— 已存在的 Installation 想换 Plugin 名称（Core）
- **`REGISTRATION_IDENTITY`** —— 已存在的 Registration 想换 Manifest 名称（Platform）
- **`ARTIFACT_IDENTITY`** —— 一份 Artifact 自身的 Manifest 和它加载出的 Plugin 名字对不上（Platform，此时可能还不存在 Registration）
:::

## 怎么处理

### 按 code 分流

```ts
try {
  await installation.ready()
} catch (error) {
  if (!(error instanceof DougongError)) throw error

  switch (error.code) {
    case "CONFIG_INVALID":
      showFieldErrors((error as ConfigValidationError).issues)
      break
    case "SERVICE_MISSING":
      suggestInstallDependency(error.message)
      break
    case "INSTALLATION_UNAVAILABLE":
      offerRetry()
      break
    default:
      report(error)
  }
}
```

### 处理聚合错误

```ts
try {
  await host.stop()
} catch (error) {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) report(cause)
  }
}
```

### 接收后台错误

后台任务、监听器和诊断订阅者抛出的异常不会中断运行时命令，它们通过 Host 的上报通道送出：

```ts
const host = createHost({
  name: "app",
  onError: (error) => reportToSentry(error),
  logger: myLogger,          // onError 未提供或自身抛错时的兜底
})
```

上报通道本身是 fail-safe 的：`onError` 抛异常会退到 logger，logger 再抛就静默——**错误观察永远不会改变它正在观察的运行时命令**。

### 终态失败的信息量

Installation 脱离 Host 之后（被移除或丢弃），它只保留错误的 `name` / `message` / `code` 纯数据摘要，读取时重建一个 Error。

原因是 JavaScript 的 `Error.stack` 可能携带创建错误时的整个编排调用帧，让一个历史对象反向保活整个 Host。

**这不影响正常路径**：等待 `ready()` 的调用方总是收到原始 `Error`；仍属于活动 Host 的失败实例也保留原始错误。只有「实例已脱离、且调用方没 await 过 ready()」的事后读取会拿到摘要——此时 `ConfigValidationError.issues` 这类子类附加数据不再可用。

## 相关

- [Core API 规范 · 错误约定](./core-api.md)
- [Platform 规范 · 稳定错误码](./platform.md)
- [事务与变更](../guide/transactions.md) —— 三级失败模型
