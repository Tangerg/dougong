# @dougong/core

能力组合与结构化生命周期内核。

- `Service` 稳定的一对一能力，依赖通过 `requires` 显式声明
- `Extension` 可动态增减的开放贡献集合
- `Event` 不保留状态的瞬时事实
- `Lifetime` 监听、贡献、任务与资源的结构化所有权
- `Application` / `ChangeSet` 事务化的安装图，失败回滚或 fail closed

不使用 Service Locator、环境作用域、原型链注入或 Proxy。运行时依赖只有 `@standard-schema/spec`。

- 文档站：https://tangerg.github.io/dougong/
- 仓库：https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。需要 Node.js >= 22 或等价的 ES2024 宿主。

MIT
