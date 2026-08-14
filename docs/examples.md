# 可执行示例

`@dougongjs/examples` 不是静态代码片段集合，而是 Dougong 公共 API 的可执行验证装置。全部场景会按顺序运行，并进入仓库的类型检查、测试、覆盖率与构建门禁。

```sh
pnpm examples
```

## 学习路径

| 章节 | 场景 | 核心能力 |
| --- | --- | --- |
| 01 | Service basics | 稳定 Service、声明依赖、宿主读取 |
| 02 | Extension and Event | 开放贡献与瞬时事实 |
| 03 | Reactive Lifetime | Signal、observe 与显式资源重建 |
| 04 | Transactions and Groups | Contract family、所有权树与原子 ChangeSet |
| 05 | Lazy Platform | Manifest、权限、placeholder 与懒激活 |
| 06 | Planet | 媒体 Provider、播放 Lifetime、动态选择与诊断 |
| 07 | Lynx | Catalog、工作区所有权、懒激活与插件更新 |
| 08 | Declarative plan | 期望状态、内容 revision 与失败回滚 |
| 09 | HMR module graph | 显式模块图、失效传播与多插件原子 HMR |

[查看示例源码](https://github.com/Tangerg/dougong/tree/main/packages/examples/src)或阅读仓库中的[完整示例说明](https://github.com/Tangerg/dougong/blob/main/packages/examples/README.md)。

## 启动拓扑基准

仓库还包含独立拓扑与链式拓扑的启动基准：

```sh
pnpm examples:benchmark
```

它只输出测量数据，不把墙钟阈值作为 CI 条件。并发语义由确定性行为测试守护，避免共享 runner 抖动制造偶发失败。
