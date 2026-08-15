# 可执行示例

`@dougongjs/examples` 不是静态代码片段集合，而是 Dougong 公共 API 的**可执行验证装置**。十二章按顺序运行，并进入仓库的类型检查、测试、覆盖率与构建门禁——文档里写的每一条语义，这里都有对应的可运行证据。

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong && pnpm install
pnpm examples
```

## 这条路径怎么设计的

三段十二章，每章**只增加一个新台阶**：

| 段 | 章 | 你在学什么 |
| --- | --- | --- |
| **一 · 原子** | 01–04 | 每章一个原语。看它单独存在时解决什么问题 |
| **二 · 组合** | 05–08 | 原语一起工作。失败长什么样、身份怎么表达、运行时怎么观察、外部代码怎么进来 |
| **三 · 真实宿主** | 09–12 | 前八章的东西排成真实应用的形状，**不引入任何新原语** |

::: tip 「层层递进」是一条测试
`example.ts` 里的 `concepts` 数组既是教学大纲，也是阅读顺序。每章声明自己**首次**引入哪些概念，测试把十二章的声明首尾相接，和 `concepts` 做全等比较。

概念重复、顺序倒置、或者某章什么新东西都没加——三者任意一件发生，CI 就红。所以这页表格不会和代码走散。
:::

## 第一段 · 原子 {#stage-1}

一次一个原语。读完这四章，你知道六个原子里的四个各自负责什么，以及为什么它们不能互相替代。

| # | 场景 | 新增概念 | 关键结论 |
| --- | --- | --- | --- |
| **01** | Service | `service` `provides` `requires` `app.get` | 安装顺序不是启动顺序，声明的依赖边才是 |
| **02** | Extension + Event | `extension` `contribute` `extension-view` `event` `contribution-dispose` | Extension 保存当前贡献，Event 什么都不留——它不是查询 API |
| **03** | Lifetime | `cleanup` `child-lifetime` `spawn` `abort-signal` | 一切归属于一棵树，释放按**注册的逆序**；子树可以独立释放 |
| **04** | Reactive | `signal` `computed` `batch` `observe` | `computed` 做纯推导不持有资源；`observe()` 是「值变化」到「资源重建」之间唯一的接缝 |

::: details 03 打印出来长这样
```
- Setup acquired open:index → open:window → open:session.
- Disposing the child released only its own subtree: cancel:session-watcher → close:session.
- Stopping released the rest in reverse: cancel:editor-watcher → close:window → close:index.
```
window 建立在 index 之上，所以先关 window 再关 index。测试断言的就是这个顺序——把 Core 里的 `.reverse()` 去掉，这一条立刻变红。
:::

## 第二段 · 组合 {#stage-2}

原语开始互相咬合。这四章覆盖的是「小项目能糊过去、大项目糊不过去」的部分。

| # | 场景 | 新增概念 | 关键结论 |
| --- | --- | --- | --- |
| **05** | 配置与失败 | `config-schema` `config-validation` `change-set` `setup-failure` `rollback` | 校验**先于**停机；回滚是「做过又撤销」，不是「没做」 |
| **06** | Contract family 与 Group | `contract-family` `group` `atomic-commit` `group-removal` | 同型多实例用显式 Contract family；Group 只表达安装所有权 |
| **07** | 诊断 | `diagnostics-view` `lifetime-snapshot` `terminal-detachment` `view-finalization` | 终态资源自动脱离父级；停机后视图定格成数据，不反向保活 Application |
| **08** | Platform | `manifest` `permissions` `placeholder` `activation` | 注册 ≠ 激活；placeholder 到真实实现的替换是一次提交 |

::: warning 05 是这条路径的转折点
前四章都是「一切顺利」的世界。05 第一次问：**声明写错了会怎样，setup 抛异常了会怎样。**

答案是 Dougong 最有辨识度的语义，也是它的主要取舍：一笔 ChangeSet 里任何一个插件失败，整笔回滚。示例里那个 audit 插件**确实启动了**，然后被撤销——`started 1 time and was released 1 time`。

如果你的场景更需要「一个插件挂了不影响其他」，请在这一章就判断清楚。
:::

## 第三段 · 真实宿主 {#stage-3}

不再介绍新 API。这四章把前面的东西排成真实应用的形状。

| # | 场景 | 新增概念 | 它证明了什么 |
| --- | --- | --- | --- |
| **09** | Planet | `runtime-selection` `live-provider-swap` `group-scoped-platform` | Provider 增删不重启 Player——Extension 不是依赖边 |
| **10** | Lynx | `domain-catalog` `workspace-ownership` `plugin-update` | 命令唯一性是领域策略；根级消费者能看到 Group 的贡献，Group 不是 Scope |
| **11** | 声明式计划 | `desired-state` `content-revision` `platform-change-set` | 期望状态 diff 成一份 ChangeSet；身份来自 Manifest name，变化来自显式 revision |
| **12** | HMR 模块图 | `module-graph` `invalidation-closure` `multi-plugin-hmr` | 沿 importer 方向传播失效；两个插件换版本，观察者只看到 1 次提交 |

::: tip 11 和 12 在证明什么
这两章对应的是成熟插件框架里动辄上千行的子系统：声明式配置加载器、热更新引擎。

它们在这里各自约 200 行，**只用公开 API**，没有引入任何新原语。这是对「Core 的抽象是否足够可展开」的检验——如果 HMR 的失效传播需要框架提供拦截点，这 200 行是写不出来的。
:::

## 每一章的形状

每章是一个导出的 async 函数，创建并完整释放自己的 Application：

```ts
import { diagnostics } from "@dougongjs/examples"

const result = await diagnostics()
console.log(result.facts)
```

返回值里的 `facts` 是**这一轮真实观察到的**输出，不是设计意图的复述。测试断言其中的关键语义，所以示例失效会让 CI 变红——它们不会悄悄过期。

- [示例源码](https://github.com/Tangerg/dougong/tree/main/packages/examples/src)
- [示例包说明](https://github.com/Tangerg/dougong/blob/main/packages/examples/README.md)

## 启动拓扑基准

仓库还包含独立拓扑与链式拓扑的启动基准：

```sh
pnpm examples:benchmark
```

它只输出测量数据，**不把墙钟阈值作为 CI 条件**。并发语义由确定性行为测试守护，避免共享 runner 的抖动制造偶发失败。

典型结果（20 个各自 sleep 20ms 的插件）：

| 拓扑 | 说明 | 量级 |
| --- | --- | --- |
| 独立 | 20 个互不依赖的插件 | 接近单个插件耗时——同层并发 |
| 链式 | 20 个首尾相接的插件 | 接近 20 倍——依赖强制串行 |

这正是分层并发应有的形态：能并发的并发，该串行的串行。

## 接下来

- [核心概念](./guide/concepts.md) —— 示例里出现的原子各自解决什么
- [事务与变更](./guide/transactions.md) —— 05 那条回滚语义的完整规则
- [Core API 规范](./reference/core-api.md) —— 每个 API 的精确语义
