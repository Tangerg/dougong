# Dougong 可执行示例 / Executable examples

```sh
pnpm examples
pnpm examples:benchmark
```

## 简体中文

从[十二章导航](../docs/examples.md)选择示例。每章使用正式包入口，运行真实的 Host，返回本次观察到的事实。课程阶段与新增概念由[课程表](./src/example.ts)定义；运行顺序见[示例套件](./src/suite.ts)。各章的实现、测试和文档可以分别回答“怎么做”“保证什么”“从哪里开始”。

应用章节演示所有权如何跨越包边界：

- [Planet](./src/09-planet.ts)：Player 拥有当前曲目；调用方只读。上一次播放的音频操作迟到完成时，不会覆盖当前曲目或发出过期事件。
- [Lynx](./src/10-lynx.ts)：工作区 Group 负责安装归属，命令目录负责业务命令选择；加载后才有可借用的执行者。
- [声明式部署](./src/11-declarative-plan.ts)：[DeploymentController](./src/deployment-controller.ts) 私有持有专属 Platform，按提交顺序串行执行完整的目标集合请求，再将目标集合和移除集合交给一次激活。
- [模块失效](./src/12-hot-module-replacement.ts)：应用拥有导入图，Platform 拥有当前选择；受影响的选择合并到一个 Core Plan。

部署控制器在 `deploy()` 接受请求时捕获 Artifact 数组；后续修改调用方数组不会改写排队中的请求。同名版本或不同目标集合的并发请求都会分别完成选择、计算移除和激活，失败不会阻塞后续请求。返回值沿用 Platform 的 `ApplyResult | undefined`：发生 Core 提交时返回提交结果，无需提交时返回 `undefined`。Catalog 和诊断直接复用 Platform 的能力；控制器不保存第二份选择或已提交实现。应用释放控制器时，由 Platform 的标准异步释放协议处理取消和卸载；应用仍拥有 Host 的生命周期。加载、授权和插件回调不能等待同一控制器的后继部署请求，因为该请求要等当前请求结束后才能执行。

[放弃等待](./src/abandon-on-abort.ts)和[晚到资源交接](./src/retired-acquisition.ts)是两个补充示例。仅当晚到结果可以安全忽略时，才直接放弃等待；需要释放的资源必须留给能等到它返回的所有者。参见[生命周期指南](../docs/guide/lifetime.md)。

## English

Choose a chapter from the [examples guide](../docs/en/examples.md). Each chapter uses public package entrypoints, runs a real Host and returns observed facts. The [curriculum](./src/example.ts) defines stages and concepts; the [suite](./src/suite.ts) runs the chapters in order. Tests check observable behavior, including the difference between retiring a waiter and releasing the underlying resource.

The application chapters show who owns each decision. [Planet](./src/09-planet.ts) exposes a read-only track and refuses to publish a superseded playback result. [Lynx](./src/10-lynx.ts) keeps workspace ownership separate from command selection. [Deployment](./src/11-declarative-plan.ts) uses a [DeploymentController](./src/deployment-controller.ts) that privately holds a dedicated Platform and serializes complete desired-set requests in submission order, with one activation per request. [Hot module replacement](./src/12-hot-module-replacement.ts) computes module invalidation without keeping a second registry of selected plugins.

`deploy()` captures the Artifact array when it accepts a request, so later caller mutations cannot rewrite queued intent. Concurrent revisions of one name and concurrent different desired sets each finish selection, removal calculation and activation before the next request begins. A failed request does not block later requests. The return value preserves Platform's `ApplyResult | undefined`: a Core commit returns its result; an activation needing no commit returns `undefined`. Catalog and diagnostics are Platform's existing capabilities; the controller keeps no second selection or committed implementation registry. Disposing the controller delegates cancellation and removal to Platform's standard asynchronous disposal protocol; the application still owns the Host lifetime. Loading, authorization and plugin callbacks cannot await a later deployment on the same controller because that request waits for the current request to finish.

For non-cooperative operations, compare [abandoning a wait](./src/abandon-on-abort.ts) with [handing off a late resource](./src/retired-acquisition.ts). The [Lifetime guide](../docs/en/guide/lifetime.md) explains which owner joins the work. The startup benchmark reports timings without treating them as a CI correctness threshold. Its delay must be an integer from 1 through 2,147,483,647 milliseconds; zero, fractional and overflowing delays are rejected so the reported input is the delay passed to the timer without truncation or clamping. Actual elapsed times still depend on runtime scheduling.
