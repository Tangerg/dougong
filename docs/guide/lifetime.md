# 生命周期与资源

Lifetime 以组合构成资源树。根由 Instance 创建，插件通过 `child(label)` 创建子所有者。所有公开句柄采用标准释放协议，不要求第三方资源增加自定义方法。

| 原子能力 | 承诺 |
| --- | --- |
| `use(resource)` | 捕获标准释放方法，成功登记后返回原资源 |
| `defer(fn)` | 登记最终释放函数，返回可提前释放的句柄 |
| `child(label)` | 创建由父树拥有的子 Lifetime |
| `spawn(task)` | 启动可取消后台任务，Task 提供 `result` |
| `acquire(factory)` | 在创建之前登记义务，迟到资源仍归该树负责 |
| `interrupt(fn)` | 登记排空工作之前必须执行的中断操作 |
| `signal` | 合作式取消信号 |
| `[Symbol.asyncDispose]()` | 加入唯一的退出执行 |

退出先封闭入口、撤销发布并传播取消，执行中断，等待使用中的工作与创建义务，最后逆序释放资源。用 `interrupt` 关闭阻塞读取的通道，用 `defer` 执行任务退出后才能进行的最终销毁。

```ts
const connection = await lifetime.acquire(async (signal) => openConnection(signal));
lifetime.interrupt(() => connection.interruptRead());
lifetime.spawn((signal) => connection.readUntilClosed(signal));
```

清理失败不能宣称已经干净退出。Lifetime 保留失败释放和未完成工作；Host 的 `unresolved` 投影仍被保留的运行代次。子树没有成功退出时，不能释放它仍可使用的父资源；同理，未退出消费者的传递提供者必须保留，独立分支则继续安全清理。正在使用的前台借用也不能被强制销毁。

超时只结束等待，不证明底层工作已停止；已经启动的退出可能随后完成，但清理失败不会自动重试。隔离是整个 Host 的终止状态，迟到完成只更新诊断，不恢复服务。AbortSignal 无法强杀任意 JavaScript；硬终止需要实际执行隔离。应用的处置和替换前提见[隔离后的应用处理](./transactions.md#quarantine)。

Task 自己拥有后台异常报告。前台 `host.use` 和贡献 `use` 的失败传播给调用者；不要把同一个错误再次作为后台失败抛出。Lifetime 快照中的任务数、借用数和未完成义务是资源事实的只读投影。

对于不可取消的外部操作，示例的 `acquireForLifetime` 展示两层所有权：代次等待可以结束，而较长寿命的操作所有者继续等待并回收迟到结果。该业务策略由 `spawn`、`defer` 和 AbortSignal 组合，核心不隐藏资源义务。
