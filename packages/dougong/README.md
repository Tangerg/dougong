# dougong

Dougong 的门面包，聚合 `@dougongjs/core`、`@dougongjs/reactive` 与 `@dougongjs/platform`。

只做 re-export，不包含任何逻辑——架构门禁会强制这一点。

```ts
import { createApp, definePlugin, service } from "dougong"
```

- 文档站：https://tangerg.github.io/dougong/
- 仓库：https://github.com/Tangerg/dougong

> 早期开发阶段（0.0.x），当前不承诺向后兼容。需要 Node.js >= 22 或等价的 ES2024 宿主。

MIT
