# 生命周期与资源

Lifetime 以组合构成资源树。根由 Instance 创建，插件通过 `child(label)` 创建子所有者。插件通过根视图 `context.lifetime` 登记资源和任务；只有 Engine 能停止 Instance。插件不能通过该视图释放整个实例。需要提前结束一组工作时，创建并保存 `child(label)` 返回的 `ChildLifetime`。

| 原子能力 | 承诺 |
| --- | --- |
| `use(resource)` | 捕获标准释放方法，成功登记后返回原资源 |
| `defer(cleanup)` | 登记最终释放函数，返回可提前释放的句柄 |
| `child(label)` | 创建由父树拥有的子 Lifetime |
| `spawn(task)` | 启动可取消后台任务，Task 提供 `result` |
| `acquire(factory)` | 创建前登记义务；返回的 Promise 以冻结的 `{ resource }` 回执完成 |
| `interrupt(interruptWork)` | 登记排空工作之前必须执行的中断操作 |
| `signal` | 合作式取消信号 |
| `child[Symbol.asyncDispose]()` | 提前关闭自己创建的子树，加入同一次退出 |

子 Lifetime 的释放义务属于创建它的父 Lifetime。同一份已加载的 Core 中，`use` 和 `acquire` 会拒绝再次接管已有子句柄。独立打包的 Core 副本各自识别句柄，跨副本使用时仍应由原来的父 Lifetime 负责释放。需要提前关闭子树时，释放 `child` 返回的句柄即可。

同一份已加载的 Core 也只允许一个 Lifetime 接管同一个外部资源对象。重复调用 `use`、并发 `acquire` 或从释放方法的 getter 重入登记都会被拒绝。释放仍在进行、已经超时或已经失败时，原所有者继续承担义务；只有实际释放成功后才能重新接管该对象。调用方应将共享资源交给一个明确的 Lifetime，并通过服务参数传递使用权。

`Symbol.dispose` 必须同步完成；异步释放应使用 `Symbol.asyncDispose`。同步回调返回 Promise 或 thenable 会被拒绝，失败释放仍归原 Lifetime。Core 与 Reactive 的同步结果检查共用一份协议：保留标准 Promise 原型标记的原生 Promise，包括跨 realm 的对象和子类，由内建 `then` 验证并观察实际结算，自有 `then` 或 `Symbol.toStringTag` 不能替代它。检查不执行展示标签的 getter，也不会再次解析原生 Promise 已完成的载荷；普通 thenable 的 `then` 只捕获一次，并保留原 receiver。

该检查不修改传入对象。完全替换 Promise 原型链或篡改其原型标记，不属于原生 Promise 识别保证。Proxy 的反射陷阱可以影响候选检查，伪造 Promise 原型或循环原型链会明确失败。原生 `constructor` 或 `Symbol.species` 阻止观察时，错误直接传播，不降级为同步成功；标准 JavaScript 没有绕过这些钩子的公开观察操作，此时不能保证接住原 Promise 的拒绝。资源所有者仍保留失败的释放义务。

退出先封闭入口、撤销发布并传播取消，发起全部中断并等待它们完成，再等待使用中的工作与创建义务，最后逆序释放资源。用 `interrupt` 关闭阻塞读取的通道，用 `defer` 执行任务退出后才能进行的最终销毁。

```ts
const { resource: connection } = await lifetime.acquire(async (signal) => openConnection(signal));
lifetime.interrupt(() => connection.interruptRead());
lifetime.spawn((signal) => connection.readUntilClosed(signal));
```

工厂结果遵循正常的 Promise 解析规则。接管完成后，`receipt.resource` 就是 Lifetime 捕获释放方法时的那个对象。用回执交付，避免 Promise 再次把资源当作 thenable 解析成别的值。原先直接接收资源的调用方按上例解构 `resource`。

清理失败不能宣称已经干净退出。Lifetime 保留失败释放和未完成工作；Host 的 `unresolved` 投影仍被保留的运行代次。子树没有成功退出时，不能释放它仍可使用的父资源；同理，未退出消费者的传递提供者必须保留，独立分支则继续安全清理。正在使用的前台借用也不能被强制销毁。

通过 child 或 defer 句柄提前释放时，清理失败同样使整个 Host 进入隔离。Lifetime 上报释放失败，Engine 先撤销可用性，再捕获错误诊断并清理独立安全分支；直接调用者仍收到原释放失败，Host 的错误报告端口接收隔离结果。错误对象的 getter 不能趁诊断捕获重新借用 Service。准备中或恢复中的候选也归这次退出处理，不能在故障之后提交。

`shutdownTimeoutMilliseconds` 为正数且最多为 2,147,483,647 毫秒（原生计时器上限）；不设置即不限制等待时间。超时只结束等待，不证明底层工作已停止；已经启动的退出可能随后完成，但清理失败不会自动重试。隔离是整个 Host 的终止状态，迟到完成只更新诊断，不恢复服务。AbortSignal 无法强杀任意 JavaScript；硬终止需要实际执行隔离。应用的处置和替换前提见[隔离后的应用处理](./transactions.md#quarantine)。

子 Lifetime 的关闭截止时间独立生效。即使根已经进入关闭流程，子截止时间到期仍立即使整个 Host 隔离；子清理赶在根截止时间之前完成，也不能让停止或更新成功。Lifetime 保留对真实子清理工作的等待，Engine 依据失败来源保持唯一的终态隔离，父资源和服务提供者不会因子等待回执超时而被提前释放。

取消以原生 AbortSignal 的状态为准。手动派发名为 `abort` 的事件不会取消子树或任务，也不会使它们错过随后真正的取消。Lifetime 通过自己拥有的任务和子树传播取消；公开信号的监听器阻止事件派发，也不能阻止这些结构化的取消。

成功退出后，每个 Lifetime 都暴露自己已经中止的信号。保留子树句柄不会再保留原控制器及其监听器；其他已退出子树也不能通知这个信号的监听器。

每次独立退出创建独立的取消原因，同一次树形取消向后代传播同一原因。操作应保存开始时取得的 signal，并用它判断该操作的取消；`spawn` 和 `acquire` 已把对应信号传给回调。成功退出后的句柄暴露脱离原资源图的已取消信号，不再用于重建此前操作的原因身份。

Task 自己拥有后台异常报告。前台 `host.use` 和贡献 `use` 的失败传播给调用者；不要把同一个错误再次作为后台失败抛出。任务完成和借用释放都以交给调用者的同一个 Promise 为准。Lifetime 快照中的任务数、中断数、借用数和未完成义务是资源事实的只读投影。事件监听器、快照订阅者和错误回调的 JavaScript `this` 不携带内部所有者；请使用插件显式获得的能力。Lifetime 在公开任务或获取结果前就登记自己的等待，给返回的 Promise 装饰方法不会提前解除所有权。

`isCancellationReason(signal, error)` 只在原生信号已经取消且错误携带同一个取消原因时成立：错误本身就是 `signal.reason`，或者错误是名为 `AbortError` 的 Error，且自有数据属性 `cause` 就是这个原因。后一种形式覆盖 Node 异步计时器等保留取消原因的接口。仅有 `AbortError` 名称不足以证明因果；独立错误不会因为稍后发生取消而被省略。自定义适配器应保留真正的取消原因，不能用错误名称推断来源，也无需包裹独立失败来避免误判。

对于不可取消的外部操作，示例的 `acquireForLifetime` 展示两层所有权：代次等待可以结束，而较长寿命的操作所有者继续等待并回收迟到结果。该业务策略由 `spawn`、`defer` 和 AbortSignal 组合，核心不隐藏资源义务。

例子在外部操作开始前就在长寿命操作所有者上登记回收义务。代次接受资源后，释放权移交给代次；若操作所有者在移交前退出、代次已退出或登记被拒绝，均由原所有者回收。创建未成功是任务错误；已取得资源却回收失败则仍是未完成的清理义务，Host 不能报告已正常停止。

子树撤回发布时的错误会携带原始原因向上传播。即使发布项先解除登记再抛错，子树仍承担失败的释放义务；父级诊断提供有界错误快照。
