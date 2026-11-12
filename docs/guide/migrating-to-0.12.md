# 从 0.11 迁移到 0.12.0

将使用中的 `dougong`、`@dougongjs/platform` 和 `@dougongjs/reactive` 一起升级到 0.12.0，再执行应用的类型检查和集成测试。[Release Notes](../reference/release-0.12.0.md) 列出完整发布范围。

## 显式声明资源身份域

`createHost` 不再接受省略的选项，`HostOptions.resourceAuthority` 为必填项。应用为每个资源共享域创建一个 authority；共享资源的 Host 和 Core 副本使用同一个对象。

```ts
import { createHost, createResourceAuthority } from "dougong";

const resourceAuthority = createResourceAuthority();
const application = createHost({ resourceAuthority, name: "application" });
const preview = createHost({ resourceAuthority, name: "preview" });
```

authority 只裁决资源身份的接管预约和控制句柄来源，实际释放仍归 Lifetime。多个 Host 共用 authority 不会允许重复接管同一资源。不同 authority 表示明确独立的域；跨域传递使用权时，释放仍留给原所有者，不要为同一资源另建一个接管入口。见[生命周期与资源](./lifetime.md)。

## 保留完整的插件作者合同

安装和替换前先使用 `definePlugin`，或通过明确的 `Plugin<...>` 注解检查声明。未检查的原始对象不再直接作为静态安装声明使用。展开已有 Plugin 后若改变 `requires`、`provides`、schema 或 setup，重新调用 `definePlugin` 检查完整结果。

`requires` 与 `provides` 必须声明有限、确定、必填的字符串别名。非空映射不能省略对应字段；setup 的参数注解和返回值也不能补出缺失的声明。不要把联合的提供映射与独立选择的 setup 组合起来；分别定义完整 Plugin，再选择其中一个。没有 schema 时，配置输入必须能赋给 setup 的配置输出类型，类型参数不能代替实际转换。

加载器处理未知模块时使用 `dougong/advanced` 的 `capturePluginDeclaration`，得到经过运行时检查、明确擦除作者类型的 `AnyPlugin`。不要通过断言把未知模块伪装成已检查的 Plugin。完整规则见[编写插件](./writing-plugins.md)。

## 接入取消和恢复等待

`host.start(signal)` 与 `host.apply(plan, signal)` 新增可选的 AbortSignal；原有不传信号的调用仍然适用。需要限制恢复准备阶段的等待时，设置 `restorationTimeoutMilliseconds`。

取消使执行进入恢复，不证明非协作 setup 或资源释放已经结束。清理或恢复不能建立健康状态时，Host 进入终态隔离；保留原义务，不自动重试清理。Plan 仍然绑定 Host、修订并且只能消费一次。见[事务与变更](./transactions.md)。

## 检查适配器的结果与释放协议

本地原生 Promise 通过 intrinsic `then` 观察实际结算；装饰公开的 `then` 不能替代结算，`Symbol.toStringTag` 也不再参与协议选择。外部 realm 和结构化 thenable 使用一次捕获的公开 `then` 及其原接收者。若 intrinsic 观察被 `constructor` 或 `Symbol.species` 阻止，原错误直接传播，不切换到另一套协议。完整保证范围见[异步结果协议](./lifetime.md)。

同步协议不能返回 Promise。适配器需要同样的边界检查时，可使用新增的 `dougong/advanced` 导出 `assertSynchronous`。ResourceAuthority 的两个方法及 claim 释放回调同样必须同步完成。内部贡献视图和订阅直接归 Lifetime 的同步清理记录所有，只登记控制句柄来源，不申请外部资源 claim。

Host 诊断读取失败属于观察失败；它不能把已提交的 Platform 选择或激活改写为失败，也不能阻止关闭取消已接纳的工作。订阅解绑失败仍保留失败的退出回执，重复关闭不会重试。见[Platform 规范](../reference/platform.md)。
