# Dougong 0.12.0 Release Notes

0.12.0 显式声明跨 Host、跨 Core 副本的资源身份域，收紧插件作者合同，并加入请求取消与恢复等待控制。本次发布同时修复资源、贡献、异步结算、Platform 观察及发布恢复中的所有权边界。相对 0.11.0 有破坏性变更，升级前请阅读[迁移指南](../guide/migrating-to-0.12.md)。

## 发布包

`dougong`、`@dougongjs/platform` 和 `@dougongjs/reactive` 同步发布为 0.12.0。

```sh
pnpm add dougong@0.12.0
```

## 破坏性变更

- `createHost` 的选项变为必填，必须显式传入 `resourceAuthority`。共享资源的 Host 和 Core 副本共用一个 authority；Lifetime 仍是实际释放义务的唯一所有者。
- 安装与替换必须保留已检查的 Plugin 作者合同。依赖和提供别名必须有限、确定且必填；原始对象、独立拼接的联合映射与 setup、以及只通过类型参数声称发生的配置转换不再通过静态检查。
- 本地原生 Promise 的结算由 intrinsic 协议观察，公开 `then` 与呈现标签不再决定结算来源。适配器须遵守[异步结果协议](../guide/lifetime.md)的保证范围。

## 新能力

- `host.start(signal)` 和 `host.apply(plan, signal)` 接受可选的调用方取消信号；`restorationTimeoutMilliseconds` 限制恢复准备的等待。
- 主入口新增 `createResourceAuthority` 与 `ResourceAuthority`；`dougong/advanced` 新增 `capturePluginDeclaration` 和 `assertSynchronous`。

## 修复与内部整理

- 资源 claim 释放回执只发起一次尝试，重入及后续调用复用原结果。失败释放和失败的接管回滚保留原 Lifetime 义务与独立错误。
- 监听器、贡献及子 Lifetime 在调用外部控制登记前确立所有权。登记失败时撤销本次登记，父 Lifetime 等待实际回滚；失败义务不会因控制句柄已关闭而丢失。
- 贡献视图与订阅直接组合 Lifetime 同步清理，移除平行租约和重复归还路径。失败原因先成为终态，再通知和捕获诊断；重复释放再次抛出原原因且不重试，包括 `undefined`。
- 依赖准备失败参与同一层的取消与回滚。调用方取消登记失败不消费 Plan，也不提前封闭运行中的 Instance。
- setup、任务、资源接管及 Platform 的计划和执行观察实际 Promise 结算。结构化包装不能提前结束内部工作、替换真实失败或再次吸收已兑现的原生载荷。
- Reactive 观察先捕获取消句柄，退出等待源观察、当前子 Lifetime 与排空工作，保留独立的排空和清理失败。
- Platform 的提交结果与诊断读取解耦；关闭先撤销本地观察绑定，再调用外部解绑。操作准入、取消与退出共享同一条操作记录和失败回执。
- 发布会话等待命令后代实际退出。清单恢复使用绑定源位置的单一事务，并发调用共享一次结果；失败或 checkout 移动不会被后续调用误报为成功，也不会自动重试恢复。

## 发布验证

发布脚本在目标版本上执行完整 `pnpm check`，覆盖生成文件、类型、lint、格式、测试与按包覆盖率、未使用代码、依赖和架构边界、构建、公开 API、Node 与三种真实浏览器中的打包消费者，以及双语文档。上传前后核对经过消费者验证的实际归档。

完整变更：[v0.11.0…v0.12.0](https://github.com/Tangerg/dougong/compare/v0.11.0...v0.12.0)。[English release notes](../en/reference/release-0.12.0.md)。
