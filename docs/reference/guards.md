# 机械守卫

`pnpm check` 依次执行生成源校验、源码与消费者类型检查、lint、格式、带分包覆盖率的行为测试、未使用代码分析、循环依赖分析、责任边界检查、生产构建、发行声明面检查和文档构建。

## 架构规则

| 规则 | 含义 |
| --- | --- |
| `ownership.package` | 每个源码包必须声明责任 |
| `ownership.module` | 新的责任目录默认拒绝 |
| `direction.package` | 包依赖只能沿声明方向 |
| `direction.module` | 低层不得导入高层责任 |
| `types.suppressions` | 禁止静默禁用类型检查 |
| `types.precise` | 禁止显式 any |
| `callbacks.readonly` | Port 与 Control 使用只读函数属性 |
| `tests.types` | 编译期断言归 public-api.types.ts |
| `runtime.portable` | 运行库不能依赖 Node 内建模块 |
| `exports.public` | 跨包只使用正式公开入口 |
| `modules.esm` | 相对源码导入具有显式运行时扩展名，发行类型支持 NodeNext |
| `reactive.independent` | reactive 保持零外部依赖 |
| `vocabulary.current` | 退休词汇不能返回实现 |
| `logging.port` | 库日志由 Logger 端口控制 |
| `policy.explicit` | 库策略不读取环境时钟或随机数 |
| `lifetime.owner` | Lifetime 根仅由执行层或既有树创建 |
| `contracts.owner` | 固定 Contract ID 只有一个定义所有者 |

## 覆盖率下限

| Package | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| dougong | 93 | 86 | 96 | 96 |
| platform | 97 | 92 | 100 | 99 |
| reactive | 96 | 89 | 100 | 99 |

行为测试覆盖原子发布、计划权限、恢复与隔离、生命周期义务、取消、跨副本信号与隔离的打包消费者。门禁变异测试证明非法依赖方向确实失败。API 守卫检查包含纯类型导出的发行声明面，要求中英文记录所有导出和错误码，并按真实 Markdown 文件校验导航。协议生成文件只有 `tooling/internal` 中一个源所有者，修改源后重新生成。
