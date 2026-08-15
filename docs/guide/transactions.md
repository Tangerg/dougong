# 事务与变更

运行中的应用需要装插件、卸插件、换配置。Dougong 的保证是：

> **事务只暴露已提交的状态。** 变更要么整体生效，要么运行图回到变更前——不会出现半装好的运行时。

## 单个变更

```ts
const handle = host.install(plugin, config)   // 立刻返回 Handle
await handle.ready()                         // 等待这次安装真正就绪

await handle.update({ config: nextConfig })
await handle.remove()
```

`install()` 在 `app` 未启动时只登记声明；启动后调用会触发一次运行期事务。

## 多插件原子变更：ChangeSet

需要**一起成功或一起失败**的多个操作，用 `change()`：

```ts
const changes = host.change()
changes.install(newProvider)
changes.update(oldHandle, { plugin: nextVersion })
changes.remove(deprecatedHandle)
await changes.commit()          // 一笔事务
```

这是多插件变更的**正式入口**。`install()` / `update()` / `remove()` 只是它的单条退化形式——它们内部走同一条路径，没有第二套状态机。

ChangeSet 的性质：

- **一次性** —— `commit()` 之后不能再修改，重复 `commit()` 返回同一个 Promise
- **每个实例一个操作** —— 同一个 Handle 不能在一笔 ChangeSet 里既 update 又 remove
- **提交前不生效** —— 没 commit 就丢弃的 draft 不会污染运行时

## 失败时发生什么

Dougong 有三级失败处理，按严重程度递增：

### 1. 回滚（rollback）

新的运行图起不来 → 恢复变更前的运行图，`host.status` 回到 `active`。

```ts
const changes = host.change()
changes.install(brokenPlugin)
await expect(changes.commit()).rejects.toThrow("setup failed")

expect(host.status).toBe("active")     // 其他插件完全不受影响
```

### 2. Fail closed

旧图**也**恢复不了（比如某个插件的 cleanup 抛了异常，无法确认它是否真的释放了资源）→ 不假装健康，把 Host 停到 `idle`，并抛出聚合了全部原因的错误。

宁可让应用代码看到「我停了，原因是这些」，也不呈现一个可能已经损坏的运行时。

### 3. 聚合上报

停止阶段的多个失败会被聚合成 `AggregateError`，每一条原因都保留。没有任何错误会被静默吞掉。

### 校验先于停机

**所有受影响插件的配置会在停止任何运行中实例之前全部校验完毕。**

```ts
const changes = host.change()
changes.update(a, { config: validConfig })
changes.update(b, { config: invalidConfig })   // 这个会校验失败
await expect(changes.commit()).rejects.toMatchObject({ code: "CONFIG_INVALID" })

// a 和 b 都没有被停止过 —— 运行图一动没动
```

一个拼错的配置字段不会让你的应用停在半路。

## 增量重启

变更不会重启整个应用。Dougong 计算**受影响闭包**：变更的插件，加上依赖它们的传递闭包，在**新旧两张图**上取并集。

```text
A ← B ← C        更新 B
D ← E            E 与 B 无关

受影响：B、C       不动：A、D、E
```

无关插件不会被停止，它们的 Service 实例、Lifetime、后台任务全部原样保留。

## 启动模型

`host.start()` 分四步：

1. **构图** —— 从 `requires` / `provides` 推导依赖图，检测环和重复提供者
2. **校验** —— 全部配置通过 Standard Schema
3. **分层并发启动** —— 同一拓扑层的插件并发 setup
4. **整层提交** —— 该层全部 Service 输出校验通过后，才统一注册 Service、发布暂存的监听与贡献

第 4 步是「事务只暴露已提交状态」在启动阶段的形态：setup 期间注册的监听器和贡献是**暂存**的，同层任何一个插件失败，这一层的暂存内容一条都不会发布。

```text
prepare 失败时该层的可观察结果：

公开 Service          0
公开 Contribution     0
公开 Listener         0
已登记 Contract kind   0
已取得资源            全部尝试释放
```

### 构图期错误

这些错误在**任何插件启动之前**抛出：

| 错误码 | 触发条件 |
| --- | --- |
| `SERVICE_CYCLE` | 依赖成环，消息里带真实环路径 |
| `SERVICE_CONFLICT` | 两个插件提供同一个 Service |
| `SERVICE_MISSING` | 必需 Service 没有提供者 |
| `CONTRACT_CONFLICT` | 同一 ID 被当作两种 kind |

环检测的消息给的是真实路径，不是「所有没排上序的插件」：

```text
Plugin dependency cycle: app.a:1 -> app.b:2 -> app.a:1
```

## Group：安装所有权树

Group 用来把一组插件当作一个单元管理：

```ts
const feature = host.group("editor", (plugins) => {
  plugins.install(syntax)
  plugins.install(formatter)

  plugins.group("lsp", (nested) => {      // 可嵌套
    nested.install(languageServer)
  })
})

await feature.ready()      // 等待整棵子树就绪
feature.status             // 聚合状态
await feature.remove()     // 整棵子树一起移除
```

`configure` 回调**必须是同步的**（返回 Promise 会抛错），因为整个 Group 的内容需要作为一笔 ChangeSet 提交。

Group 也可以发起自己的事务：

```ts
const changes = feature.change()   // 只能操作这个 Group 子树内的插件
changes.install(extra)
await changes.commit()
```

### Group 不改变可见性

::: warning 这是最容易误解的一点
Group **只表达安装所有权**。它不是能力作用域、不是 provider 影子树、不是权限边界、不是安全沙箱。

Service 解析、ExtensionPoint 和 Event 的可见范围**始终是整个 Host**。把插件放进 Group 不会让它「只看到」Group 内的能力。
:::

那么这些需求怎么办：

| 需求 | 正确做法 |
| --- | --- |
| 同型多实例（多个 workspace 各有一份 store） | 显式 Contract family：`service<Store>(\`app/ws/${id}/store\`)` |
| 运行期选择租户 | 普通方法参数：`store.forTenant(id)` |
| 安全隔离 | 独立 Host、Worker、iframe 或进程——真正的隔离边界 |

### 已建立的 Group 不会被失败污染

```ts
const group = host.group("stable", (p) => p.install(good))
await group.ready()

const changes = group.change()
changes.install(broken)
await expect(changes.commit()).rejects.toThrow()

expect(group.status).toBe("active")            // 仍然健康
await expect(group.ready()).resolves.toBeUndefined()
```

已经成功建立过的 Group，遇到一次完整回滚的失败变更后，继续呈现上次提交的状态。而从未建立成功的 Group（第一次提交就失败）会保持 `failed`。

## 观察状态

```ts
host.status
// "idle" | "starting" | "active" | "changing" | "stopping"

host.diagnostics.get()
// { name, status, plugins: ReadonlyMap<string, InstallationSnapshot>, groups, ... }

host.diagnostics.subscribe(() => render())
```

`changing` 状态存在的意义：运行期事务进行中时，应用代码的读窗口是关闭的——`host.get()` 会抛 `SERVICE_UNAVAILABLE`，而不是让你读到一个正在被替换的中间状态。

## 接下来

- [响应式与观察](./reactive.md) —— 用 Signal 驱动 Lifetime 重建
- [外部插件分发](./platform.md) —— Manifest、权限、懒激活
- [Core API 规范](../reference/core-api.md) —— 精确语义与边界情形
