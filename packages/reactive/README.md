# @dougong/reactive

零依赖的响应式原语：`signal` / `computed` / `batch` / `observe`。

与 `@dougong/core` 互不依赖——`observe()` 是一个作用在结构化 `ObservationOwner` 上的自由函数，因此可以驱动 Core 的 Lifetime，而 Core 不需要知道它存在。

- 文档站：https://tangerg.github.io/dougong/
- 仓库：https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。需要 Node.js >= 22 或等价的 ES2024 宿主。

MIT
