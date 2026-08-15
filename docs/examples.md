# 可执行示例

`@dougongjs/examples` 不是静态代码片段集合，而是 Dougong 公共 API 的**可执行验证装置**。九个场景会按顺序运行，并进入仓库的类型检查、测试、覆盖率与构建门禁——文档里写的每一条语义，这里都有对应的可运行证据。

```sh
git clone https://github.com/Tangerg/dougong.git
cd dougong && pnpm install
pnpm examples
```

## 学习路径

三段递进：先是单个原子，然后是原子的组合，最后是真实宿主形态。

### 第一段 · 原子

| # | 场景 | 学到什么 |
| --- | --- | --- |
| **01** | Service basics | 稳定 Service、`requires` 声明依赖、`app.get()` 宿主读取的边界 |
| **02** | Extension and Event | 开放贡献集合 vs 瞬时事实，以及为什么它们不能互换 |
| **03** | Reactive Lifetime | Signal、`observe()` 与显式资源重建：值变了，旧资源先释放再建新的 |

### 第二段 · 组合

| # | 场景 | 学到什么 |
| --- | --- | --- |
| **04** | Transactions and Groups | Contract family 表达同型多实例、Group 的所有权树、一笔原子 ChangeSet |
| **05** | Lazy Platform | Manifest 校验、权限授权、placeholder 占位与懒激活的原子替换 |

### 第三段 · 真实宿主

| # | 场景 | 学到什么 |
| --- | --- | --- |
| **06** | Planet | 媒体 Provider 注册表、播放 Lifetime、运行期动态选择与诊断读取 |
| **07** | Lynx | Catalog、工作区所有权、懒激活与保持身份的插件更新 |
| **08** | Declarative plan | 把「期望状态」diff 成部署记录，再编译成 ChangeSet；内容 revision 与失败回滚 |
| **09** | HMR module graph | 显式模块图、沿依赖者方向的失效传播、多插件原子热更新 |

::: tip 08 和 09 在证明什么
这两个场景对应的是成熟插件框架里动辄上千行的子系统（声明式配置加载器、热更新引擎）。

它们在这里各自约 200 行，**只用公开 API**，没有引入任何新原语。这是对「Core 的抽象是否足够可展开」的一次检验——如果 HMR 的失效传播需要框架提供拦截点，这 200 行是写不出来的。
:::

## 源码与说明

- [示例源码](https://github.com/Tangerg/dougong/tree/main/packages/examples/src)
- [示例包说明](https://github.com/Tangerg/dougong/blob/main/packages/examples/README.md)

每个示例都是一个导出的 async 函数，返回结构化的 `ExampleResult`，由 `suite.ts` 统一驱动。测试会断言它们的输出，所以**示例失效会让 CI 变红**——它们不会悄悄过期。

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
- [Core API 规范](./reference/core-api.md) —— 每个 API 的精确语义
