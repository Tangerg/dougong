# 机械守卫

`pnpm check` 依次执行生成源校验、源码与消费者类型检查、lint、格式、带分包覆盖率的行为测试、未使用代码分析、循环依赖分析、责任边界检查、生产构建、发行声明面检查和文档构建。

## 架构规则

| 规则 | 含义 |
| --- | --- |
| `ownership.package` | 每个源码包必须声明责任 |
| `ownership.module` | 生产源码必须属于已声明职责，不能依赖工作区测试、工具或其他非生产目录 |
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
| `vocabulary.current` | 检查退休词汇，要求项目自有声明使用完整名称 |
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

架构守卫从 TypeScript 符号识别契约工厂；别名与命名空间导入仍指向同一个定义。通过常量或只读属性传入的固定 ID 也要参与相同的冲突检查。跨包入口和运行时目标从实际解析的模块和包的 `exports` 检查，覆盖再导出、字面量动态导入和导入类型。发布前还要验证 tarball 具有每个公开入口的 JavaScript 和类型文件，包括 `dougong/advanced`。

公开 API 的预期清单只在 `tooling/architecture/public-api.json` 中维护。源码测试、发行声明及四个真实 ESM 入口都对照这份清单检查。

发布时先设置目标版本，再运行完整门禁。消费者测试与发布使用同一组归档：隔离应用通过后，消费者才记录归档哈希。其余检查完成后，发布端核对哈希、源清单、本次实际获取的远端提交及远端标签，然后才允许首次上传。每次上传前重新核对远端分支和标签，记录 Git 版本时以预检得到的远端引用为条件。已存在的版本和首次上传的版本，都必须从注册表读回，逐文件核对后才记录 Git。

每个发布清单都明确列出需要分发的文件或目录（使用字面路径）。打包必须保留这些文件，包括 `dist/` 之外声明的资源；不能额外引入其他文件或元数据。工作区依赖按受检版本解析，包管理器专用字段和打包生命周期脚本可以不进入产物。ESM 构建从各包的清单推导外部依赖及其子路径。声明检查根据 TypeScript 的模块命名空间区分真正可用的构造器和仅作类型再导出的类。

预发布需要为每个包指定 npm 分发标签。可执行 `pnpm release 0.7.2-alpha.1 --tag=next --dry-run` 检查，再去掉 `--dry-run` 发布。命令行标签覆盖各包的 `publishConfig.tag`。标签以 ASCII 字母或数字开头，后续可包含字母、数字、点、下划线和连字符，并须与 SemVer 范围明确区分。部分上传后使用相同的标签恢复，先前已发布的版本会按归档内容核验。
