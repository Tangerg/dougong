# 整体架构

Dougong 采用三个发布包。`dougong` 是内核；`@dougongjs/platform` 是依赖内核的交付层；`@dougongjs/reactive` 独立并通过结构协议组合。根目录的 `examples` 是下游应用，`tooling` 是构建、门禁与发行工具。

| Directory | Responsibility |
| --- | --- |
| `packages/dougong/src/contracts` | Identity, protocols, statuses, error and logging contracts |
| `packages/dougong/src/internal` | Shared low-level record, queue and protocol primitives |
| `packages/dougong/src/observation` | Stable snapshots and publication |
| `packages/dougong/src/lifetime` | Resource ownership and shutdown |
| `packages/dougong/src/events` | Synchronous event publication |
| `packages/dougong/src/contributions` | Owned contribution collections |
| `packages/dougong/src/composition` | Plugin declarations, configuration, graph and Plan |
| `packages/dougong/src/inspection` | Derived diagnostic projections |
| `packages/dougong/src/execution` | Instance execution and the single Engine |
| `packages/platform/src/artifacts` | Immutable distribution declarations |
| `packages/platform/src/catalog` | Known Artifacts and selection handles |
| `packages/platform/src/admission` | Admission policy |
| `packages/platform/src/loaders` | Module delivery |
| `packages/platform/src/activation` | Selection-aware compilation to Core Plans |
| `packages/reactive/src` | Signals, Readable bridge and owned observation |
| `examples/src` | Application-level composition |
| `tooling/architecture` | Responsibility and emitted API guards |
| `tooling/release` | Artifact verification and publishing |


## 所有权和方向

Engine 拥有唯一已提交状态和 stateRevision。安装句柄、Host、Plan 与诊断是有边界的协议或投影，不再各自维护竞争的状态机。PlanAuthority 拥有计划执行权限；Lifetime 拥有资源义务；Registration 只拥有选择意图，执行来源归 Installation origin。

低层不知道高层。contracts 不导入 execution；lifetime 不导入 events 或 contributions；事件与贡献使用 Lifetime 的发布和借用原子能力。inspection 从事实构建稳定快照；observation 是可复用低层协议，不能与高层诊断目录混合。

跨包只走 exports 定义的入口。`dougong/advanced` 为下游组合保留正式原语；没有核心注册表或私有控制口。物理目录按这些责任划分，模块守卫对新目录默认拒绝，新增责任必须显式设计。

## 边界承诺

整笔提交的发布原子性覆盖服务、事件监听、贡献及来源。候选运行的外部副作用不在自动回滚承诺中。退出失败保留义务并隔离，而不是清空集合假装成功。

代理与人使用相同的结构化 PlanReport、HostSnapshot、错误 details 与 apply。实际配置内容不复制进报告；如需代理 schema，使用显式 schema 出口，不从任意 TypeScript 类型猜测。

## 参考设计

设计报告比较了能力声明、生命周期、加载与隔离等不同职责。以下是相关项目的一手文档；各自机制用于校验具体边界，而不是整体复制一个框架。

- [Backstage services](https://backstage.io/docs/backend-system/architecture/services/) and [extension points](https://backstage.io/docs/backend-system/architecture/extension-points/)
- [pluggy](https://pluggy.readthedocs.io/en/stable/)
- [OSGi Declarative Services](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)
- [VS Code activation events](https://code.visualstudio.com/api/references/activation-events)
- [Vite plugin API](https://vite.dev/guide/api-plugin) and [Rollup plugin development](https://rollupjs.org/plugin-development/)
- [Fx lifecycle](https://uber-go.github.io/fx/lifecycle.html)
- [ECMAScript resource management](https://tc39.es/ecma262/multipage/managing-memory.html)
- [Standard Schema](https://standardschema.dev/)
