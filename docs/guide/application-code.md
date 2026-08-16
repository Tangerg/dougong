# 从应用代码消费能力

Plugin 位于依赖图内：它声明 `requires`，资源由 Instance 的 Lifetime 所有。应用代码位于图外：它驱动 Host，并且自己负责所取得订阅与 Installation 的所有权。两种位置使用不同的公开入口，但读取的是同一份已提交状态。

## 读取 Service

Host active 时，应用代码用 `get()` 执行命令或读取稳定能力：

```ts
await host.start()
host.get(PLAYER).play(track)
```

`get()` 在 idle 或 changing 时抛 `SERVICE_UNAVAILABLE`，从不返回候选图或半重建状态。应用代码要探测一个可选能力时，仍使用同一个入口和同一个可选性原子：

```ts
const analyser = host.get(optional(ANALYSER)) // Analyser | undefined
```

必需 Service 缺失仍会抛错；只有 `optional()` 明确标注“允许没有 provider”。`Service<void>` 的存在与缺失都会得到 `undefined`；依赖应提供真实的 port 接口或有意义的领域状态，不能用 `Service<void>` / `Service<true>` 伪装安装顺序钩子。

## 观察 ExtensionPoint

应用代码用 `contributions()` 获得 Host 拥有的稳定 `ContributionView`：

```ts
const commands = host.contributions(COMMANDS)

const render = () => {
  toolbar.replace([...commands.get().values()])
}

const subscription = commands.subscribe(render)
await host.start()
render()

// 应用代码拥有这份订阅
subscription.dispose()
```

视图可在启动前创建，跨 stop/start 保持身份，并且只呈现事务提交后的快照。因为它与 Host 同寿命，保留该 View 也会有意保留 Host 的观察链路；应让两者一起退出作用域。Plugin 中仍通过 `requires` 取得由当前 Lifetime 拥有的视图；不要为了让 UI 读取贡献而生成一份收集所有 ExtensionPoint 的 bridge Plugin。

Contribution Map 的 key 是 Core 生成的所有权身份，包含 Installation ID，重装后会变化。领域 ID、排序权重和权限标签属于 value：

```ts
interface Command {
  readonly id: string
  readonly order: number
  readonly run: () => void
}

const ordered = [...commands.get().values()].sort(
  (left, right) => left.order - right.order,
)
```

若领域要求 ID 唯一，组合器应扫描 value 并明确拒绝冲突。Core 不把某一个领域的唯一性、排序或覆盖策略写进 ExtensionPoint。

## 将 Event 接到 UI

Event 是 Instance 之间的瞬时事实，因此 Host 不提供 `on()` 或 `emit()`。图外 UI 要接收事实时，写一个通过 `ctx.on()` 注册 Listener 的 bridge Plugin，并在 Listener 中更新应用自己的 store 或 Signal；该 Listener 自然归 bridge Instance 的 Lifetime 所有。Event 不建立依赖图边，bridge 若依赖某个 Service 的存在或启动顺序，仍须在 `requires` 中显式声明该 Service。

初始状态不要通过 setup 期 Event 播种。它属于 Service getter、Signal/Readable，或者 ExtensionPoint 的当前快照。Event 不缓存、不重放，同层 setup 也不存在可依赖的监听先后顺序。

## 保留控制句柄

需要卸载或替换时，组合根应保留 `install()` 返回的 Installation：

```ts
const installations = new Map<string, Installation>()
installations.set("player", host.install(playerPlugin))

await installations.get("player")?.remove()
```

diagnostics 只负责观察，永远不是 control plane。依赖图中的边必须指向真实能力；提供那个能力的 port 或领域状态，不要增加 marker 原子，也不要用空 Service 编码安装顺序。
