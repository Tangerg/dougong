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
- [声明式部署](./src/11-declarative-plan.ts)：控制器读取专属 Platform 当前的 Registration，将目标集合和移除集合交给一次激活。
- [模块失效](./src/12-hmr-module-graph.ts)：应用拥有导入图，Platform 拥有当前选择；受影响的选择合并到一个 Core Plan。

[放弃等待](./src/abandon-on-abort.ts)和[晚到资源交接](./src/retired-acquisition.ts)是两个补充示例。仅当晚到结果可以安全忽略时，才直接放弃等待；需要释放的资源必须留给能等到它返回的所有者。参见[生命周期指南](../docs/guide/lifetime.md)。

## English

Choose a chapter from the [examples guide](../docs/en/examples.md). Each chapter uses public package entrypoints, runs a real Host and returns observed facts. The [curriculum](./src/example.ts) defines stages and concepts; the [suite](./src/suite.ts) runs the chapters in order. Tests check observable behavior, including the difference between retiring a waiter and releasing the underlying resource.

The application chapters show who owns each decision. [Planet](./src/09-planet.ts) exposes a read-only track and refuses to publish a superseded playback result. [Lynx](./src/10-lynx.ts) keeps workspace ownership separate from command selection. [Deployment](./src/11-declarative-plan.ts) reconciles a dedicated Platform's current Registrations in one activation. [HMR](./src/12-hmr-module-graph.ts) computes module invalidation without keeping a second registry of selected plugins.

For non-cooperative operations, compare [abandoning a wait](./src/abandon-on-abort.ts) with [handing off a late resource](./src/retired-acquisition.ts). The [Lifetime guide](../docs/en/guide/lifetime.md) explains which owner joins the work. The startup benchmark reports timings without treating them as a CI correctness threshold.
