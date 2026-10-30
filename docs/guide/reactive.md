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

模块副本内的 computed 追踪属于该副本自己的节点。跨 bundle、跨版本副本或其他实现的输入使用 `Readable<T>` 协议，通过显式 `bridge(owner, source)` 进入本地依赖图。`BridgeOwner` 只需要 `defer`；桥接订阅由调用方 Lifetime 拥有，没有跨副本全局 collector。

bridge 在订阅后重新读取以封闭挂接窗口。所有者退出时取消外部订阅、通知本地依赖失效并清除保存的值。退出后的 get 和 subscribe 拒绝继续使用；不要把桥接的存活期延长到其所有者之外。

`observe(owner, source, observer)` 按源值创建子所有者。替换时先完整退出旧子树，再创建新的子树；多个变化在进行中的切换间合并为最新值。返回 `AsyncDisposable`，可以提前结束观察。

公开类型：`Readable`、`Signal`、`ReadonlySignal`、`Disposable`、`AsyncDisposable`、`BridgeOwner`、`ObservationOwner`、`ObservationTask`、`Observer`。`ObservationOwner` 以 `defer`、`child`、`spawn` 和标准释放协议描述结构能力；兼容对象无需继承框架类。

observer 自身同步登记资源，需要异步工作的回调显式 `generation.spawn`。抛出的失败由该观察任务的所有者报告，旧代次退出失败不会静默启动新代次。
