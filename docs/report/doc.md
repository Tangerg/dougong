已完成修复，并生成了可直接 `git apply` 的补丁：

**:chatgpt-content-reference{index="0"}[dougong-upstream-fixes-60755b7.patch](sandbox:/workspace/scratch/157ba3016705/deliverables/dougong-upstream-fixes-60755b7.patch)**

补丁基于本轮通过 GitHub 连接器核验的 `main`，与反馈报告的基线一致：

```text
60755b7e3c4bb5ca5bfea57b363ca35614b2202a
chore: release 0.7.0
```

已按该提交的 [AGENTS.md](https://github.com/Tangerg/dougong/blob/60755b7e3c4bb5ca5bfea57b363ca35614b2202a/AGENTS.md) 和 [PROJECT_RULES.md](https://github.com/Tangerg/dougong/blob/60755b7e3c4bb5ca5bfea57b363ca35614b2202a/PROJECT_RULES.md) 完成实现、回归和独立审查。补丁涉及 **12 个文件**，主要包含示例实现、36 项新增测试、双语文档，以及必要的测试类型配置。

## 这次具体修复了什么

### 1. D1：修复监听器泄漏，并消除取消检查与启动之间的竞态

原来的 `abandonOnAbort` 有两处问题：

| 问题 | 本次处理 |
| --- | --- |
| 预取消 signal 先注册 listener，再直接调用取消回调，留下不会自动移除的监听器 | 在注册监听器之前处理预取消，保证不注册、不启动 |
| `throwIfAborted()` 和 `start()` 分属两个 Promise reaction，取消可能夹在两者之间 | 将最后一次取消检查与 `start()` 放在同一个同步回调中执行 |

第二处是在这轮针对报告验收条件复核时进一步确认的：原实现可能出现“等待已经取消，尚未开始的操作却仍被启动”。

同时，**中英文指南中的两份内联实现已经删除，改为直接引入测试所执行的同一份 TypeScript 源码**。这样，修复后的实现、回归测试和文档展示有同一个来源。

修复后仍保留原有适用边界：这个 helper 只负责显式放弃等待，适用于迟到值和迟到失败都可以安全忽略的操作；底层操作的迟到 rejection 仍会被观察。

### 2. D2：交付完整受测的等待退役与晚到资源交接范式

按照报告要求，D2 以应用组合示例交付，并配齐测试和文档。它明确区分两个所有者：

| 所有者 | 负责的内容 |
| --- | --- |
| `generation` | 可以退役的等待，以及已经及时取得的资源 |
| `operations` | 真正的外部异步操作、晚到资源释放，以及这些操作的错误上报 |

这套范式实现了以下行为：

- **及时取得资源**：先同步注册 `generation.cleanup()`，再交付结果。
- **资源在退役后才返回**：由 `operations` 内的任务释放，恰好一次，不交给后任 generation。
- **操作失败或晚到 disposer 失败**：统一通过原操作 Task 的既有 Host 错误通道上报。
- **失败与取消交错**：错误上报不依赖等待者能否收到结果，避免漏报；等待者读取失败结果时也不会自动重复上报。
- **外部异常名为 `AbortError`**：保留原始 `cause`，并在外部操作边界包装错误，避免最终 Host 停止时被误判为该 Task 的协作取消。
- **资源交接失败**：回收尚未成功归属的资源；交接和回收都失败时保留两个原因。

这里有一个必须保留的契约：**旧 generation 可以先退出，但真实操作仍归 `operations` 所有。**如果底层操作或晚到 disposer 永不结束，最终 `operations.dispose()`、`host.stop()` 仍会等待。文档已经明确说明这一点，Core 原有的 abort + join 语义保持成立。

### 3. D3–D5：按报告保持既有归属

这几项在报告中并不是待修复的 Dougong 实现缺陷。本次继续使用现有的 SnapshotPublisher、Lifetime cleanup、Host 错误观察和 SerialQueue。

Contribution 的领域覆盖、排序、UI 提交资格、远端命令身份与重试决策，继续由应用拥有。补丁没有引入兼容层、旧 API 别名、运行时 polyfill，也没有增加 Core 或 facade 公共 API。

依赖方面，只新增了支撑真实 Node API 回归测试所需的 **Node 22 开发类型依赖**。锁文件核对确认：原有 **541 条包版本记录均未升级或删除**。

## 验证结果

最终在 **Node v24.19.0 / pnpm 10.14.0** 下执行完整 `pnpm check`，退出码为 **0**：

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| oxlint，禁止 warnings | 通过 |
| Prettier | 通过 |
| Vitest | **29 个测试文件、357 项测试全部通过** |
| 原覆盖率门槛 | 通过，未调整门槛 |
| knip、循环依赖、层级与架构检查 | 通过 |
| 全部 5 个包构建 | 通过 |
| 发布 API 检查 | 通过 |
| 中英文 VitePress 文档构建 | 通过 |

新增测试为 **D1 的 11 项 + D2 的 25 项**，覆盖取消时序、资源交接、`observe()` 替换、错误归属、最终 join，以及应用选定的同 identity 串行与不同 identity 并发。

还做了三组反证，确认测试能检出所保护的问题：

- 换回原始文档 helper：两项测试分别检出监听器残留和取消后仍启动。
- 删除晚到资源释放：两种微任务顺序下的测试都检出 disposer 未执行。
- 移除外部错误包装：三项测试检出 Host 停止期间独立 `AbortError` 被漏报。

最终构建出的中英文页面也已逐字核对：两份示例源码在各语言页面中都完整出现一次。

## 如何应用

在你的 dougong 仓库根目录执行，将下面的路径替换为实际下载位置：

```bash
git apply --check /path/to/dougong-upstream-fixes-60755b7.patch
git apply /path/to/dougong-upstream-fixes-60755b7.patch

pnpm install --frozen-lockfile
pnpm check
```

**补丁可应用性已经实际验证**：我在上述基线的干净工作树上完成了 `git apply --check`、实际应用、反向检查和 whitespace 检查；应用后的 **12 个变更文件均与通过最终验证的代码逐字节一致**。
