# Dougong 示例 / Examples

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

这个包是一条**可执行**的渐进学习路径。十二章，每章只增加一个新概念，全部只使用公开 `dougong` facade——不导入 Core 内部模块，也没有仅供示例使用的特权。因此它同时是「Core 抽象是否闭合」的验证装置。

在仓库根目录运行：

```sh
pnpm examples             # 依次运行十二章并打印观察到的事实
pnpm examples:benchmark   # 单独运行启动拓扑基准
```

### 三段十二章

| 段 | 章 | 主题 |
| --- | --- | --- |
| **一 · 原子** | 01–04 | 每章一个原语，各自解决什么问题 |
| **二 · 组合** | 05–08 | 原语一起工作：失败、身份、观察、外部代码 |
| **三 · 完整应用** | 09–12 | 实际应用形态，不引入任何新原语 |

**第一段 · 原子**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 01 | [`01-service.ts`](./src/01-service.ts) | `service` · `provides` · `requires` · `host.get` |
| 02 | [`02-extension-event.ts`](./src/02-extension-event.ts) | `extension-point` · `contribute` · `contribution-view` · `event` · `contribution-dispose` |
| 03 | [`03-lifetime.ts`](./src/03-lifetime.ts) | `cleanup` · `child-lifetime` · `spawn` · `abort-signal` |
| 04 | [`04-reactive.ts`](./src/04-reactive.ts) | `signal` · `computed` · `batch` · `observe` |

**第二段 · 组合**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 05 | [`05-config-failure.ts`](./src/05-config-failure.ts) | `config-schema` · `config-validation` · `change-set` · `setup-failure` · `rollback` |
| 06 | [`06-contracts-groups.ts`](./src/06-contracts-groups.ts) | `contract-family` · `group` · `atomic-commit` · `group-removal` |
| 07 | [`07-diagnostics.ts`](./src/07-diagnostics.ts) | `diagnostics-view` · `lifetime-snapshot` · `terminal-detachment` · `view-finalization` |
| 08 | [`08-platform.ts`](./src/08-platform.ts) | `manifest` · `permissions` · `placeholder` · `activation` |

**第三段 · 完整应用**

| # | 文件 | 新增概念 |
| --- | --- | --- |
| 09 | [`09-planet.ts`](./src/09-planet.ts) | `call-time-selection` · `live-provider-swap` · `group-bound-platform` |
| 10 | [`10-lynx.ts`](./src/10-lynx.ts) | `domain-catalog` · `workspace-ownership` · `registration-update` |
| 11 | [`11-declarative-plan.ts`](./src/11-declarative-plan.ts) | `desired-state` · `content-revision` · `platform-change-set` |
| 12 | [`12-hmr-module-graph.ts`](./src/12-hmr-module-graph.ts) | `module-graph` · `invalidation-closure` · `multi-registration-hmr` |

### 「层层递进」是一条测试，不是一句话

[`example.ts`](./src/example.ts) 里的 `concepts` 数组是这门课的教学大纲，也是阅读顺序。每章声明自己**首次**引入哪些概念：

```ts
return exampleResult({
  id: "03",
  stage: "atoms",
  title: "Structured ownership: cleanups, child Lifetimes and tasks",
  introduces: ["cleanup", "child-lifetime", "spawn", "abort-signal"],
  facts: [ /* 这一轮真实观察到的输出 */ ],
})
```

测试把十二章声明的概念首尾相接，和 `concepts` 做**全等比较**。所以下面三件事任意一件发生，CI 就会红：

- 某章引入了重复概念（说明它不是新台阶）
- 某个概念在需要它的章节**之后**才被引入（说明顺序倒了）
- 某章什么新东西都没加

### 每一章都是一个完整的应用

每个导出函数创建并完整释放自己的 Host，返回结构化结果：

```ts
import { diagnostics } from "@dougongjs/examples"

const result = await diagnostics()
console.log(result.facts)
```

`facts` 是**这一轮真实观察到的**输出，不是设计意图。测试会断言其中的关键语义，因此示例失效会让 CI 变红——它们不会悄悄过期。

### 为什么第三段这样拆

**09 · Planet（媒体应用）**

- Audio output 与 Player 是稳定 Service；媒体 Provider 是实时 ExtensionPoint 贡献。
- 增删 Provider 不重启 Player——ExtensionPoint 不是依赖边。
- 每次播放拥有一个子 Lifetime，替换和取消边界完全显式。
- Platform 挂在 `/providers` Group 上，移除该 Group 即移除全部下载来的 Provider。

**10 · Lynx（工作台）**

- 命令唯一性由领域 `CommandCatalog` Service 负责，而不是 Core ExtensionPoint 的特殊模式。
- 工作区身份使用显式 Contract family；Group 只拥有工作区安装子树。
- Explorer placeholder 在激活前贡献可展示元数据；更新保持 Registration 与 Installation 身份，只换 Instance。
- 根级消费者能看到工作区贡献，诚实展示 Group **不是**能力 Scope。

**11 / 12 · 应用策略**

- 声明式计划只是应用的期望状态控制器；每次 reconcile 机械编译成一份 Platform ChangeSet，不复制校验、加载或回滚状态机。
- Registration 身份只用 Manifest name；计划另带显式内容 revision 判断 Artifact 是否变化，不从路径、对象内容或执行状态猜测。
- HMR 图由 watcher / bundler 适配器显式提供；示例只计算反向依赖闭包，不接管文件监听或 ESM cache。
- 受影响的多个插件通过一份 ChangeSet 更新，消费者只看到提交前或提交后的快照。

这两章各约 200 行，做的是成熟框架里动辄上千行的事（声明式配置加载器、热更新引擎），而且**没有引入任何新原语**。它们先作为可执行应用参考；只有多个真实应用复用出稳定边界后，才值得提炼成独立包。

### 启动拓扑基准

```sh
pnpm examples:benchmark
```

实际耗时**刻意不作为 CI 断言**。Core 测试使用确定性的屏障证明并发和事务发布；这个基准只用于在代表性运行时中观察性能数量级，避免不稳定的时间测试。

---

## English

This package is an **executable** progressive learning path. Twelve chapters, each adding exactly one new idea, all written against the public `dougong` facade only — no Core internals, no example-only privileges. That also makes it a harness verifying that Core's abstractions are closed.

Run it from the repository root:

```sh
pnpm examples             # run all twelve chapters and print what each observed
pnpm examples:benchmark   # run the startup-topology benchmark separately
```

### Three stages, twelve chapters

| Stage | Chapters | Theme |
| --- | --- | --- |
| **1 · Atoms** | 01–04 | One primitive per chapter, and the problem it exists to solve |
| **2 · Composition** | 05–08 | The primitives together: failure, identity, observation, external code |
| **3 · Complete applications** | 09–12 | Shapes real applications take, introducing no new primitive |

**Stage 1 · Atoms**

| # | File | New concepts |
| --- | --- | --- |
| 01 | [`01-service.ts`](./src/01-service.ts) | `service` · `provides` · `requires` · `host.get` |
| 02 | [`02-extension-event.ts`](./src/02-extension-event.ts) | `extension-point` · `contribute` · `contribution-view` · `event` · `contribution-dispose` |
| 03 | [`03-lifetime.ts`](./src/03-lifetime.ts) | `cleanup` · `child-lifetime` · `spawn` · `abort-signal` |
| 04 | [`04-reactive.ts`](./src/04-reactive.ts) | `signal` · `computed` · `batch` · `observe` |

**Stage 2 · Composition**

| # | File | New concepts |
| --- | --- | --- |
| 05 | [`05-config-failure.ts`](./src/05-config-failure.ts) | `config-schema` · `config-validation` · `change-set` · `setup-failure` · `rollback` |
| 06 | [`06-contracts-groups.ts`](./src/06-contracts-groups.ts) | `contract-family` · `group` · `atomic-commit` · `group-removal` |
| 07 | [`07-diagnostics.ts`](./src/07-diagnostics.ts) | `diagnostics-view` · `lifetime-snapshot` · `terminal-detachment` · `view-finalization` |
| 08 | [`08-platform.ts`](./src/08-platform.ts) | `manifest` · `permissions` · `placeholder` · `activation` |

**Stage 3 · Complete applications**

| # | File | New concepts |
| --- | --- | --- |
| 09 | [`09-planet.ts`](./src/09-planet.ts) | `call-time-selection` · `live-provider-swap` · `group-bound-platform` |
| 10 | [`10-lynx.ts`](./src/10-lynx.ts) | `domain-catalog` · `workspace-ownership` · `registration-update` |
| 11 | [`11-declarative-plan.ts`](./src/11-declarative-plan.ts) | `desired-state` · `content-revision` · `platform-change-set` |
| 12 | [`12-hmr-module-graph.ts`](./src/12-hmr-module-graph.ts) | `module-graph` · `invalidation-closure` · `multi-registration-hmr` |

### "Strictly progressive" is a test, not a claim

The `concepts` array in [`example.ts`](./src/example.ts) is both the syllabus and the reading order. Each chapter declares which concepts it is the **first** to use:

```ts
return exampleResult({
  id: "03",
  stage: "atoms",
  title: "Structured ownership: cleanups, child Lifetimes and tasks",
  introduces: ["cleanup", "child-lifetime", "spawn", "abort-signal"],
  facts: [ /* what this run actually observed */ ],
})
```

The test concatenates what all twelve chapters declare and compares it to `concepts` for **exact equality**. So CI turns red if any of these happen:

- a chapter repeats a concept (it is not a new rung)
- a concept is introduced **after** a chapter that already relied on it (the order is wrong)
- a chapter adds nothing new

### Every chapter is a complete application

Each exported function creates and fully releases its own Host, and returns a structured result:

```ts
import { diagnostics } from "@dougongjs/examples"

const result = await diagnostics()
console.log(result.facts)
```

`facts` records what the run **actually observed**, not what the design intends. Tests assert the important semantics inside them, so a stale example turns CI red — they cannot quietly rot.

### Why stage 3 is split this way

**09 · Planet (a media application)**

- Audio output and the player are stable Services; media providers are live ExtensionPoint contributions.
- Adding or removing a provider never restarts the player — an ExtensionPoint is not a dependency edge.
- Each playback owns a child Lifetime, making replacement and cancellation boundaries fully explicit.
- The Platform is scoped to the `/providers` Group, so removing that Group removes every downloaded provider with it.

**10 · Lynx (a workbench)**

- Command uniqueness belongs to a domain `CommandCatalog` Service, not to a special Core ExtensionPoint mode.
- Workspace identity uses an explicit Contract family; the Group owns only the workspace installation subtree.
- The explorer placeholder contributes displayable metadata before activation; an update preserves the Registration and Installation identities and replaces only the Instance.
- A root-level consumer can see workspace contributions, honestly demonstrating that a Group is **not** a capability scope.

**11 / 12 · Application strategies**

- The declarative plan is only an application desired-state controller; each reconcile compiles mechanically into one Platform ChangeSet, duplicating no validation, loading or rollback state machine.
- Registration identity uses only the manifest name; the plan carries an explicit content revision to decide whether an Artifact changed, rather than guessing from paths, object contents or execution state.
- The HMR graph is supplied explicitly by a watcher/bundler adapter; the example computes only the reverse dependency closure and takes over neither file watching nor the ESM cache.
- Several affected Registrations update through one ChangeSet, so consumers see only the pre-commit or post-commit snapshot.

Each is roughly 200 lines, doing what mature frameworks spend thousands of lines on (a declarative config loader, a hot-reload engine), and **introducing no new primitive**. They serve first as executable application references; only after several real applications converge on a stable boundary is one worth extracting into its own package.

### Startup-topology benchmark

```sh
pnpm examples:benchmark
```

Wall-clock timing is **deliberately not a CI assertion**. Core tests prove concurrency and transactional publication with deterministic barriers; this benchmark only observes the order of magnitude in a representative runtime, avoiding flaky timing tests.
