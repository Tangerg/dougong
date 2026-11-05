# 从 0.9 迁移到 0.10.0

0.10.0 在类型边界上明确了异步结果、回调、资源和 Platform 选择各自的所有者。从 0.9 升级需要修改调用代码；被移除的形态不提供别名或兼容适配器。[Release Notes](../reference/release-0.10.0.md) 列出本次发布的完整范围。从 0.8.3 升级时，先完成[迁移到 0.9.0](./migrating-to-0.9.md)；那份指南的示例已经使用 0.10.0 的 API。

大多数变更会表现为类型错误。三个包一起升级，执行类型检查，再按下列各节处理。

## 1. 更新运行环境

各包支持 <!-- runtime-baseline:start -->Node.js `^24.22.0 || >=26.10.0`, Chrome ≥ 119, Edge ≥ 119, Firefox ≥ 124, Safari ≥ 17.4<!-- runtime-baseline:end -->。不再支持 Node.js 22。

`isCancellationReason(signal, error)` 与 Dougong 自身的取消分类只接受所属 signal 的原因本身，或自身 `cause` 属性就是该原因的 `AbortError`。仅凭名称匹配的 `AbortError` 仍是普通失败。自定义适配器应传递 `signal.reason`，不要另行构造新的中止错误；详见[生命周期与资源](./lifetime.md)。

## 2. 解构成功结果回执

`Task.result`、`host.use`、`ContributionView.use` 和 `SerialQueue.run` 的成功结果统一为冻结的 `{ value }` 回执（`ResolvedValue<T>`）。将原来的 `const result = await operation` 改为 `const { value: result } = await operation`；只等待完成、不读取结果的调用无需解构。`acquire` 继续使用 `{ resource }`。错误仍通过 Promise 拒绝传播。

```ts
const { value: answer } = await host.use(SEARCH, (search) => search.query(query));
```

输入结果的泛型使用 `Awaited<T>`，`Task<T>` 表示最终载荷类型。`ObservationTask` 只报告完成，不再接受类型参数。回执只携带数据，不会把借用延长到回调之外，见[应用代码消费](./application-code.md)。

外部 Promise 通过其公开 `then` 观察。跨 realm Promise 必须保留正常的公开 `then`；隐藏或误导性的 `then`，以及被替换的本地 Promise 原型链，不在协议保证范围内，应在其来源 realm 内适配。完整范围见[生命周期与资源](./lifetime.md)。

## 3. 保持通知与日志同步

快照和响应式源的 `subscribe`、`batchSnapshotNotifications`、`batch`、`computed` 与 `observe` 在类型边界拒绝可识别的异步返回，包括显式指定 `void` 的调用。订阅和观察回调应同步完成登记，把异步工作交给 `lifetime.spawn`。不要通过强制断言掩盖异步回调；已经擦除为 `unknown`、`any` 或 `() => void` 的返回信息仍需要运行时检查。

`Observer<T, Child, Result>` 的第三个参数描述同步返回值，默认 `void`。普通 `observe(...)` 调用会自动推断；显式指定前两个类型参数且需要返回数据时，补充第三个参数，或将只用于通知的回调改为不返回值。

`SnapshotPublisher` 的错误报告器是同步的副作用回调，不返回业务值。将 `error => errors.push(error)` 改为 `error => { errors.push(error); }`；不要传入异步报告器。

`Logger` 默认要求四个方法同步完成且无业务返回值，Host 的日志后端与插件作用域使用这个合同，直接的异步方法会被类型边界拒绝。将异步 Host 错误报告移到 `onError`，意外返回计数等值的日志简写改成无返回代码块。Platform 的终端日志使用 `Logger<unknown>`，继续观察异步结果。

`captureLogger` 保留已知方法的返回类型；`captureLogger(unknown)` 和 `isLogger` 只得到 `Logger<unknown>`。方法存在不能证明后端是同步的，应在集成边界明确它的实际合同。

## 4. 关联绑定与安装参数

`BindingReport` 通过 `optional` 区分绑定：`optional: false` 必须有字符串 `provider`，只有可选绑定允许没有提供者。手写报告和测试数据应保持这个关联。

显式传给 `ChangeSet.install` 的类型参数表示完整参数元组，例如 `InstallationArguments<typeof plugin>`，不再是 Plugin 类型。普通调用仍会推断该元组。更新安装时，每个 Plugin 与其输入保持配对；替换后的声明无法接受全部旧输入时，必须显式提供配置。

## 5. 以批次选择 Artifact

`platform.select` 接收 Artifact 数组，并按相同位置返回 Registration，整批选择是原子的。Artifact 与 Registration 是名义身份，应从 Catalog 和 Platform 获得，不要手工构造形状相同的对象。`ImportLoader` 只接受字符串引用；在声明 Artifact 时捕获 `URL.href`。详见[外部插件交付](./platform.md)。

```ts
const [registration] = await platform.select([artifact]);
await platform.activate([registration]);
```

## 完成迁移

无法读取的 setup 输出以 [`PROVIDES_INVALID`](../reference/errors.md) 报告，并带上对应安装。子 Lifetime、任务、`defer`、`interrupt`、监听器和贡献返回的句柄控制其原始登记，`use` 与 `acquire` 会拒绝它们；应直接调用句柄的标准释放方法，见[生命周期与资源](./lifetime.md)。

完成升级后，按[迁移到 0.9.0](./migrating-to-0.9.md) 末节所列，验证借用、忙碌拒绝、退出、隔离和 Platform 激活路径。
