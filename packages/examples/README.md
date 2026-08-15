# Dougong 示例 / Examples

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

这个包是一条**可执行**的渐进学习路径。每一章只使用公开 `dougong` facade，不导入 Core 内部模块，也没有仅供示例使用的特权——因此它同时是「Core 抽象是否闭合」的验证装置。

在仓库根目录运行全部示例：

```sh
pnpm examples
```

单独运行启动基准：

```sh
pnpm examples:benchmark
```

实际耗时**刻意不作为 CI 断言**。Core 测试使用确定性的屏障证明并发和事务发布；这个基准只用于在真实宿主上观察性能数量级，避免不稳定的时间测试。

### 学习路径

三段递进：先是单个原子，然后是原子的组合，最后是真实宿主形态。

**第一段 · 原子**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 01 | [`01-service-basics.ts`](./src/01-service-basics.ts) | 稳定 Service、声明依赖与宿主 `app.get()` |
| 02 | [`02-extension-event.ts`](./src/02-extension-event.ts) | Extension 保存当前贡献；Event 表达瞬时事实 |
| 03 | [`03-reactive-lifetime.ts`](./src/03-reactive-lifetime.ts) | Signal 值组合与 `observe()` 的显式资源重建 |

**第二段 · 组合**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 04 | [`04-transactions-groups.ts`](./src/04-transactions-groups.ts) | Contract family、Group 所有权与原子 ChangeSet |
| 05 | [`05-lazy-platform.ts`](./src/05-lazy-platform.ts) | Manifest、权限、placeholder 与编译到 Core 的懒激活 |

**第三段 · 真实宿主**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 06 | [`06-planet.ts`](./src/06-planet.ts) | Planet 风格媒体 Provider、播放 Lifetime、动态选择与诊断 |
| 07 | [`07-lynx.ts`](./src/07-lynx.ts) | Lynx 风格 Catalog、工作区所有权、权限、懒激活与 HMR |
| 08 | [`08-declarative-plan.ts`](./src/08-declarative-plan.ts) | 声明式期望状态、显式内容版本与 Platform ChangeSet 回滚 |
| 09 | [`09-hmr-module-graph.ts`](./src/09-hmr-module-graph.ts) | 显式模块图、失效传播与多插件原子 HMR |

每个导出函数都会创建并完整释放自己的 Application：

```ts
import { planetScenario } from "@dougongjs/examples"

const result = await planetScenario()
console.log(result.facts)
```

测试会断言这些输出，因此**示例失效会让 CI 变红**——它们不会悄悄过期。

### 为什么高级示例这样拆

**Planet**

- Audio output 与 Player 是稳定 Service。
- 媒体 Provider 是实时 Extension 贡献，因此增删 Provider 不会重启 Player。
- 曲目变化是 Event；当前曲目是 Player Service 内部的 Signal。
- 每次播放拥有一个子 Lifetime，替换和取消边界完全显式。
- 网络 Provider 只有在激活事件与权限检查通过后才由 Platform 加载。

**Lynx**

- Filesystem 是宿主 Service；命令和面板是原始 Extension。
- 命令唯一性由领域 `CommandCatalog` Service 负责，而不是 Core Extension 的特殊模式。
- 工作区身份使用显式 Contract family；Group 只拥有工作区安装子树。
- Explorer placeholder 在激活前贡献可展示的元数据。
- 懒激活和 HMR 通过 Platform 与 canonical Core ChangeSet 更新同一个托管插件。
- 根级消费者能看到工作区贡献，诚实展示 Group **不是**能力 Scope。

**宿主策略（08 / 09）**

- 声明式计划只是宿主的期望状态控制器；每次 reconcile 都机械编译到一份 Platform ChangeSet，不复制校验、加载或回滚状态机。
- 插件身份只使用 Manifest name；计划另带显式内容 revision 判断声明是否变化，不从路径、对象内容或当前运行状态猜测。
- HMR 图由 watcher / bundler 适配器显式提供；示例只计算反向依赖闭包，不接管文件监听或 ESM cache。
- 受影响的多个插件仍通过一份 Platform ChangeSet 更新，因此消费者只看到提交前或提交后的 Extension 快照。

这两项各约 200 行，做的是成熟框架里动辄上千行的事（声明式配置加载器、热更新引擎），而且**没有引入任何新原语**。它们先作为可执行宿主参考；只有多个真实宿主复用出稳定边界后，才值得提炼成独立包。

这些不是唯一的领域策略，而是展示如何组合出复杂能力，同时不引入隐藏 Provider 查找、第二套事务引擎或框架专属生命周期 Hook。

---

## English

This package is an **executable** progressive learning path. Every chapter uses only the public `dougong` facade, imports no Core internals and receives no example-only privileges — which also makes it a harness verifying that Core's abstractions are closed.

Run every example from the repository root:

```sh
pnpm examples
```

Run the startup benchmark separately:

```sh
pnpm examples:benchmark
```

Wall-clock timing is **deliberately not a CI assertion**. Core tests prove concurrency and transactional publication with deterministic barriers; this benchmark only observes the order of magnitude on a real host, avoiding flaky timing tests.

### The path

Three stages: single atoms, then their composition, then real host shapes.

**Stage 1 · Atoms**

| # | File | New concepts |
| --- | --- | --- |
| 01 | [`01-service-basics.ts`](./src/01-service-basics.ts) | Stable Services, declared dependencies and host `app.get()` |
| 02 | [`02-extension-event.ts`](./src/02-extension-event.ts) | Extensions hold current contributions; Events express transient facts |
| 03 | [`03-reactive-lifetime.ts`](./src/03-reactive-lifetime.ts) | Signal composition and explicit resource rebuild through `observe()` |

**Stage 2 · Composition**

| # | File | New concepts |
| --- | --- | --- |
| 04 | [`04-transactions-groups.ts`](./src/04-transactions-groups.ts) | Contract families, Group ownership and an atomic ChangeSet |
| 05 | [`05-lazy-platform.ts`](./src/05-lazy-platform.ts) | Manifests, permissions, placeholders and lazy activation compiled onto Core |

**Stage 3 · Real hosts**

| # | File | New concepts |
| --- | --- | --- |
| 06 | [`06-planet.ts`](./src/06-planet.ts) | Planet-style media providers, playback Lifetimes, runtime selection and diagnostics |
| 07 | [`07-lynx.ts`](./src/07-lynx.ts) | Lynx-style catalogs, workspace ownership, permissions, lazy activation and HMR |
| 08 | [`08-declarative-plan.ts`](./src/08-declarative-plan.ts) | Declarative desired state, explicit content revisions and Platform ChangeSet rollback |
| 09 | [`09-hmr-module-graph.ts`](./src/09-hmr-module-graph.ts) | An explicit module graph, invalidation propagation and atomic multi-plugin HMR |

Each exported function creates and fully releases its own Application:

```ts
import { planetScenario } from "@dougongjs/examples"

const result = await planetScenario()
console.log(result.facts)
```

Tests assert these outputs, so **a stale example turns CI red** — they cannot quietly rot.

### Why the advanced examples are split this way

**Planet**

- Audio output and the player are stable Services.
- Media providers are live Extension contributions, so adding or removing one never restarts the player.
- A track change is an Event; the current track is a signal inside the player Service.
- Each playback owns a child Lifetime, making the replacement and cancellation boundaries fully explicit.
- The network provider is loaded by Platform only after an activation event and a permission check.

**Lynx**

- The filesystem is a host Service; commands and panels are raw Extensions.
- Command uniqueness belongs to a domain `CommandCatalog` Service, not to a special Core Extension mode.
- Workspace identity uses an explicit Contract family; the Group owns only the workspace installation subtree.
- The explorer placeholder contributes displayable metadata before activation.
- Lazy activation and HMR update the same managed plugin through Platform and the canonical Core ChangeSet.
- A root-level consumer can see workspace contributions, honestly demonstrating that a Group is **not** a capability scope.

**Host strategies (08 / 09)**

- The declarative plan is only a host desired-state controller; each reconcile compiles mechanically into one Platform ChangeSet, duplicating no validation, loading or rollback state machine.
- Plugin identity uses only the manifest name; the plan carries an explicit content revision to decide whether a declaration changed, rather than guessing from paths, object contents or current runtime state.
- The HMR graph is supplied explicitly by a watcher/bundler adapter; the example computes only the reverse dependency closure and takes over neither file watching nor the ESM cache.
- Several affected plugins still update through one Platform ChangeSet, so consumers see only the pre-commit or post-commit Extension snapshot.

Each is roughly 200 lines, doing what mature frameworks spend thousands of lines on (a declarative config loader, a hot-reload engine), and **introducing no new primitive**. They serve first as executable host references; only after several real hosts converge on a stable boundary is one worth extracting into its own package.

These are not the only possible domain strategies. They demonstrate how to compose complex capabilities without introducing hidden provider lookup, a second transaction engine or framework-specific lifecycle hooks.
