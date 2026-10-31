# 响应式与观察

`@dougongjs/reactive` 零外部依赖，不依赖 Host。`signal` 创建可写 `Signal`，`computed` 产生惰性 `ReadonlySignal`，`batch` 合并通知。调用 `get()` 读取，`subscribe(listener)` 仅通知变化，不立即重放；释放订阅使用标准 `Disposable`。

```ts
import { bridge, computed, observe, signal } from "@dougongjs/reactive";

const query = signal("");
const readableFromAnotherBundle = obtainReadable();
const local = bridge(lifetime, readableFromAnotherBundle);
const title = computed(() => `${query.get()}: ${local.get()}`);

observe(lifetime, title, (value, generation) => {
  generation.spawn((signal) => render(value, signal));
});
```

写入立即使依赖它的 computed 失效，不会执行计算。批处理推迟的是通知；哪些订阅能收到通知，在每次写入时就已确定。即使在同一个 batch 内，或在另一个监听器中，写入之后才订阅 computed 也不会收到这次写入的通知；批次中后续的写入仍可通知新订阅。

模块副本内的 computed 追踪属于该副本自己的节点。跨 bundle、跨版本副本或其他实现的输入使用 `Readable<T>` 协议，通过显式 `bridge(owner, source)` 进入本地依赖图。`BridgeOwner` 只需要 `defer`；桥接订阅由调用方 Lifetime 拥有，没有跨副本全局 collector。

bridge 在订阅后重新读取以封闭挂接窗口。所有者退出时取消外部订阅、通知本地依赖失效并清除保存的值。退出后的 get 和 subscribe 拒绝继续使用；不要把桥接的存活期延长到其所有者之外。

`observe(owner, source, observer)` 按源值创建子所有者。替换时先完整退出旧子树，再创建新的子树；多个变化在进行中的切换间合并为最新值。返回 `AsyncDisposable`，可以提前结束观察。

公开类型：`Readable`、`Signal`、`ReadonlySignal`、`Disposable`、`AsyncDisposable`、`BridgeOwner`、`ObservationOwner`、`ObservationTask`、`Observer`。`ObservationOwner` 只需提供 `defer`、`child` 和 `spawn`；它返回的子所有者实现标准异步释放协议。父所有者无需公开释放入口。

observer 自身同步登记资源，需要异步工作的回调显式 `generation.spawn`。抛出的失败由该观察任务的所有者报告，旧代次退出失败不会静默启动新代次。

适配器在接入时捕获读取、订阅和取消订阅的方法。观察在接管子所有者、任务和清理句柄时，也会保存各自的释放方法。如果自定义所有者返回的任务可以取消，但没有有效的 `result`，或读取它时抛错，观察创建失败，回滚会调用已接管的任务释放方法。取消订阅失败后，该失败仍然是所有者的释放义务；提前结束观察、排空失败和后续退出都不能通过重复调用将其变成成功。
