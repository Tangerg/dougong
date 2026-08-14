# Dougong 示例

这个包是一条可执行的渐进学习路径。每一章只使用公开 `dougong` facade，不导入 Core 内部模块，也没有仅供示例使用的特权。

在仓库根目录运行全部示例：

```sh
pnpm examples
```

单独运行启动基准：

```sh
pnpm examples:benchmark
```

实际耗时刻意不作为 CI 断言。Core 测试使用确定性的屏障证明并发和事务发布；这个基准用于在真实宿主上观察性能数量级，避免不稳定的时间测试。

## 学习路径

| 章节 | 文件 | 新增概念 |
| --- | --- | --- |
| 01 | [`01-service-basics.ts`](./src/01-service-basics.ts) | 稳定 Service、声明依赖与宿主 `app.get()` |
| 02 | [`02-extension-event.ts`](./src/02-extension-event.ts) | Extension 保存当前贡献；Event 表达瞬时事实 |
| 03 | [`03-reactive-lifetime.ts`](./src/03-reactive-lifetime.ts) | Signal 值组合与 `observe()` 的显式资源重建 |
| 04 | [`04-transactions-groups.ts`](./src/04-transactions-groups.ts) | Contract family、Group 所有权与原子 ChangeSet |
| 05 | [`05-lazy-platform.ts`](./src/05-lazy-platform.ts) | Manifest、权限、placeholder 与编译到 Core 的懒激活 |
| 06 | [`06-planet.ts`](./src/06-planet.ts) | Planet 风格媒体 Provider、播放 Lifetime、动态选择与诊断 |
| 07 | [`07-lynx.ts`](./src/07-lynx.ts) | Lynx 风格 Catalog、工作区所有权、权限、懒激活与 HMR |

每个导出函数都会创建并完整释放自己的 Application：

```ts
import { planetScenario } from "@dougong/examples"

const result = await planetScenario()
console.log(result.facts)
```

## 为什么高级示例这样拆

### Planet

- Audio output 与 Player 是稳定 Service。
- 媒体 Provider 是实时 Extension 贡献，因此增删 Provider 不会重启 Player。
- 曲目变化是 Event；当前曲目是 Player Service 内部的 Signal。
- 每次播放拥有一个子 Lifetime，替换和取消边界完全显式。
- 网络 Provider 只有在激活事件与权限检查通过后才由 Platform 加载。

### Lynx

- Filesystem 是宿主 Service；命令和面板是原始 Extension。
- 命令唯一性由领域 `CommandCatalog` Service 负责，而不是 Core Extension 的特殊模式。
- 工作区身份使用显式 Contract family；Group 只拥有工作区安装子树。
- Explorer placeholder 在激活前贡献可展示的元数据。
- 懒激活和 HMR 通过 Platform 与 canonical Core ChangeSet 更新同一个托管插件。
- 根级消费者能看到工作区贡献，诚实展示 Group 不是能力 Scope。

这些不是唯一的领域策略，而是展示如何组合出复杂能力，同时不引入隐藏 Provider 查找、第二套事务引擎或框架专属生命周期 Hook。
