# 机械守卫

Dougong 的架构主张只有一条能被检验：**能机械判断的约束，必须交给工具**。写在文档里的规则几个月后会退化成建议；写进门禁的规则不会。

这一页列出 `pnpm check` 实际执行的每一项检查，以及它保护的是哪条不变量。

```sh
pnpm check
```

十步依次执行，任一步失败即中止：

| # | 步骤 | 保护什么 |
| --- | --- | --- |
| 1 | `typecheck` | 五个 tsconfig 项目 + 测试项目，全部 `--noEmit` |
| 2 | `lint` | oxlint，`--deny-warnings` |
| 3 | `format:check` | prettier |
| 4 | `test` | 行为语义 + 覆盖率地板 |
| 5 | `knip` | 未使用的导出与依赖 |
| 6 | `check:circular` | 循环依赖 |
| 7 | `check:layers` | 依赖方向、模块分层、架构不变量、词汇 |
| 8 | `build` | 四个包的 dist 与声明文件 |
| 9 | `check:api` | 公共声明面、退役词汇、文档覆盖 |
| 10 | `docs:check` | 文档站构建与死链 |

第 8 步必须在第 9 步之前：`dist/index.d.ts` 是**完整类型面唯一被物化成产物的地方**，源码里看不到 `export *` 展开后的最终结果。

## `check:layers`

`scripts/check-layers.mjs`。四类检查。

### 1 · 依赖方向

包级：core 与 reactive 互不导入；platform 只依赖 core；facade 只能 re-export；examples 是最外层消费者，任何发布包都不得反向依赖它。

模块级：`@dougongjs/core` 和 `@dougongjs/platform` 的每个模块在表里声明 rank，只能导入 rank 更低的模块。

::: tip rank 表是穷举的，两个方向都查
新增模块没有 rank → 失败（必须有人决定它坐在哪一层）。表里的 rank 没有对应文件 → 也失败（重命名文件后忘记改表不会静默通过）。
:::

### 2 · 源码文本不变量

不能机械从类型推出、但能从源码文本判断的约束。分两类。

**禁止型**——这些东西不该出现：

| 规则 | 理由 |
| --- | --- |
| 源码不导入 `node:` 内建 | 内核必须与运行环境无关 |
| 不读 `Date.now` / `performance.now` / `Math.random` | 隐藏时钟和熵源让行为不可复现 |
| 不直接调 `console` | 必须走 Logger 端口 |
| 不深导入其他包的内部模块 | 只能用包入口 |
| TypeScript AST 中不出现显式 `any` | 用精确类型、`unknown` 或 `never` 保留检查边界，不能主动丢失类型信息 |
| `@dougongjs/reactive` 零外部导入 | 它是独立基础包 |
| 资源实现不直接使用 `[Symbol.dispose]` / `[Symbol.asyncDispose]` | 必须经过基础协议模块选择稳定 key，避免缺失 Symbol 退化成 `"undefined"` 属性 |
| facade 只含 re-export | 有逻辑就是第二条执行路径 |
| `HostImpl` 不得导出 | `Host` 是接口，`createHost()` 是唯一构造入口 |
| Lifetime 只能由 `Runtime` 和 `Lifetime` 自身构造 | 别处构造会产生无人释放的资源树 |

**要求型（反向规则）**——这些东西**必须**出现，否则说明有人另起了一条路径：

| 规则 | 它防止的第二条路径 |
| --- | --- |
| Host 命令串行化必须用 Core `SerialQueue` | 手写队列会重新引入"失败污染后续命令" |
| Platform 命令串行化必须用同一个 `SerialQueue` | 同上，跨包复制状态机 |
| Platform 诊断必须编译到 Core `SnapshotPublisher` | 复制观察协议 |
| Contribution 观察必须组合同一个 `SnapshotPublisher` | 同上 |
| Platform 加载取消必须复用 Core `isCancellationReason` | 两套取消判定 |
| Platform 声明校验必须复用 Core `assertPlainRecord` | 两套原型链校验 |
| Host 必须把安装声明与句柄权限委托给 `InstallationRegistry` | Host 重新变成总类 |
| Platform 结构协调必须把激活委托给 `Activator` | 第二条依赖激活路径 |
| `Activator` 必须信任 `CandidateGraph` 的环不变量 | 第二份、且不可达的图实现 |
| ChangeSet draft 的空提交必须过 authority 端口 | 空提交短路会让失效的 Group / Platform draft 提交成功 |
| Group 空 ChangeSet 必须跨串行化边界 | 同上 |
| Platform 空 ChangeSet 必须跨串行化命令边界 | 同上 |
| Platform 释放必须是终态 `SerialQueue` 命令 | 尾部观察者会漏掉排队中的命令 |
| Platform 释放协议必须复用 Core `asyncDisposeSymbol` | 第三份运行时 Symbol 解析逻辑 |
| Group 所有权必须用 `GroupNode` 身份 | 用 groupId 前缀编码所有权是隐式关系 |

反向规则是这套门禁里最不常见、也最重要的一类：普通门禁说"不许写 X"，反向规则说"**必须写 X**"。前者防退化，后者防分叉。

### 3 · 退役词汇（源码）

`scripts/vocabulary.mjs` 是唯一真相源，列出词汇重建中被淘汰的所有标识符。

检查走 **TypeScript AST**，只匹配标识符与字符串字面量，所以散文与概念名不会被误判：

```text
extension-point          概念名，出现在散文里     → 放行
PluginHandle             类型标识符              → 失败
"PLUGIN_DEPENDENCY_..."  退役错误码字面量         → 失败
```

### 4 · 固定 Contract ID 唯一性

全工作区扫描 `service("...")` / `extensionPoint("...")` / `event("...")`，同一个字面量 ID 声明两次即失败，并报出首次声明的位置。

::: warning 它只覆盖字面量
`` service<T>(`workspaces/${id}/store`) `` 这类动态 Contract family 是**刻意跳过**的——运行期 ID 的唯一性无法静态判定。门禁只声称它能证明的部分，不做过度承诺。

调用被识别的前提是能追踪到工厂来源，因此 `import { service as svc }` 别名和 `import * as dougong` 命名空间两种写法都能识别。
:::

## `check:circular`

`scripts/check-circular.mjs`，madge，**允许列表为空**。

每个包都作为库发布，`@dougongjs/core` 两个模块之间的值级循环会在消费者的打包器里表现为**半初始化的绑定**，而不是在我们的测试里报错。所以这里比在应用里更严格。

## `check:api`

`scripts/check-api-surface.mjs`。读取四个包**构建后**的 `dist/index.d.ts`，用 TypeScript checker 解析导出符号——不是文本匹配，所以 `export *` 展开后的最终消费者视角能被看见。

每个包四条独立断言：

1. **导出标识符精确等于 allowlist**（值导出与类型导出分列）。新增导出是一次刻意决定，不能是 `export *` 的副作用。
2. **退役标识符不得重新进入公共面**。用整 token 列表而非模式，所以合法名字不受影响：

   ```text
   Plugin  PluginContext  InstanceMeta  definePlugin   → 合法
   PluginHandle  PluginDefinition  ExtensionView       → 退役
   ```
3. **每个公开导出都必须出现在中英双语文档里**。更新 allowlist 不能留下一个没人解释的 API。
4. **构建后的声明文件不允许出现 `any`**。源码门禁看不到 declaration emit 推断出的类型，因此这里扫描全部发布 `.d.ts`，防止类型信息在包边界静默丢失。

facade 的面不重述而是**算出来**：它必须恰好等于 core + platform + 转发的 reactive 名字，多一个少一个都失败。

四个发布包的 `engines` 与 `browserslist` 还必须和工作区根的运行时基线完全一致；包之间不能声明互相矛盾的支持范围。

另外还有跨源码与文档的检查：

- **错误码**从源码派生，两份错误码参考表必须**穷举**列出，其余页面**不得发明**源码不抛的码。
- **文档的代码片段**不得使用退役标识符。只提取带代码语言标注的围栏块与行内 `` `code` `` span，散文不受影响。

文档导航同样从文件树派生：中英文的每个 guide、reference 和 examples 页面都必须同时出现在对应侧边栏与首页，导航也不得保留已经删除的页面。新增页面不再可能只挂进其中一份清单。

## 测试侧的守卫

### 运行期形状

`packages/core/test/api-surface.test.ts` 断言 `Object.keys()` 的精确结果：Context 暴露哪些键、Handle 是否冻结、内部编排方法是否泄露。类型面由 `check:api` 守，运行期形状由它守——两者互补，因为类型擦除后 `Object.keys` 才是消费者真正看得到的东西。

### 覆盖率地板

`vitest.config.ts` 按包设置阈值，取值贴着实测地板（裕度 ≤ 1 个点）：

| 包 | statements | branches | functions | lines |
| --- | --- | --- | --- | --- |
| core | 92 | 83 | 96 | 95 |
| platform | 97 | 90 | 100 | 98 |
| reactive | 96 | 89 | 100 | 99 |

一个包不能靠工作区里别处的高覆盖率掩盖自己的回归。阈值定得贴近实测是有意的：留出裕度就等于允许悄悄删测试。

`check:api` 会从 `vitest.config.ts` 推导这张表并核对中英文页面；提高门槛却忘记更新文档不能通过。

## 怎么加一条新守卫

1. **先写门禁，在当前代码上跑，确认它失败。** 照着已完成的结果补写的规则是快照，不是测试。
2. 修代码让它通过。
3. **反向验证**：把被保护的行为撤掉，确认门禁变红，再还原。

第 3 步是这个仓库对所有重要不变量的强制要求——[working rules](https://github.com/Tangerg/dougong/blob/main/AGENTS.md) 里写着"For important regressions, verify that the test fails when the protected behavior is removed"。

## 相关

- [整体架构](./architecture.md) —— 这些约束保护的分层与设计论证
- [Core API 规范](./core-api.md) —— 被守护的公共语义
- [错误码](./errors.md) —— 由源码派生、门禁核对的那张表
