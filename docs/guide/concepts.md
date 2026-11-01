# 核心概念

每个事实只有一个所有者，其他对象保存引用或生成只读投影。

| 概念 | 负责的事实 |
| --- | --- |
| Service | 一个稳定身份下的单一能力协议 |
| ExtensionPoint | 开放集合的贡献协议 |
| Event | 一次瞬时广播的载荷协议；emit 等待监听完成 |
| Plugin | 配置 schema、依赖声明、提供声明与 setup |
| Installation | 稳定安装身份；状态与来源从 Engine 投影，只读 |
| Instance | 一次 setup 运行产生的服务与 Lifetime |
| ChangeSet | 一笔尚未规划的声明意图 |
| Plan | 基于特定 stateRevision 的不可变执行计划 |
| Engine | 已提交声明、配置、来源、绑定、代次、执行阶段与切换 |
| Lifetime | 资源、子树、任务、获取和使用中的义务 |
| Catalog | 已知的不可变 Artifact |
| Registration | 用户选择的 Artifact 与选择修订 |

`PluginContext.dependencies` 是已声明依赖的解析结果；`lifetime`、`events`、`contributions` 是各自职责的操作入口。依赖别名不会与框架操作争抢同一个平面。

例如，插件声明 `requires: { storage: STORAGE }` 后，setup 可以通过 `context.dependencies.storage` 使用已绑定的服务。当前安装的身份信息在 `context.metadata` 中，日志通过 `context.logger` 写出。

Service 的必需依赖按拓扑装配；`optional(service)` 在没有提供者时为 `undefined`。提供者改变会重建受影响的消费者，以维持代次内引用稳定。ExtensionPoint 允许多个贡献，键由发布所有者限定；消费者自行决定排序与选择策略。

Group 是声明组织与批量移除边界。Lifetime 是运行资源树。两者分别描述部署组织和资源所有权，不能互相替代。

Host 和 Platform 的诊断都是派生视图。`stateRevision` 来自 Engine 的已提交运行状态；通知次数、进度变化和任务计数不产生第二个状态版本。
