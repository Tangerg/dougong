# 响应式与观察

`@dougongjs/reactive` 零外部依赖，不依赖 Host。`signal` 创建可写 `Signal`，`computed` 产生惰性 `ReadonlySignal`，`batch` 合并通知。调用 `get()` 读取，`subscribe(listener)` 不立即重放。`Signal` 仅在值变化时通知；computed 在失效时通知，此时尚未重新计算，值可能没有改变，订阅者需要确认时自行读取并比较。释放订阅使用标准 `Disposable`。

显式释放订阅或观察时，从 `@dougongjs/reactive` 导入 `disposeSymbol` 或 `asyncDisposeSymbol`。这些键在缺少原生释放符号的运行环境中也可用。

`batch`、`computed`、`subscribe` 与 `observe` 的回调必须同步完成。公开类型拒绝直接返回 Promise、PromiseLike，以及包含异步分支的联合结果；显式指定 `void` 也不能隐藏异步返回。已经擦除为 `unknown`、`any` 或无返回函数类型的动态输入仍由运行时校验。异步回调在被拒绝前可能已经产生副作用，后续续体也不能由批次撤回。Promise 可以作为数据保存，例如 `signal(promise)` 或 `computed(() => ({ pending: promise }))`；需要异步工作时，通过 Lifetime 的 `spawn` 管理其退出义务。

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

写入立即使依赖它的 computed 失效，不会执行计算。订阅者即使推迟读取，也会持续收到后续写入的失效通知。批处理推迟的是通知；哪些订阅能收到通知，在每次写入时就已确定。即使在同一个 batch 内，或在另一个监听器中，写入之后才订阅 computed 也不会收到这次写入的通知；批次中后续的写入仍可通知新订阅。两次写入之间，共享依赖只需验证一次；重复读取菱形依赖图不会沿每条路径重复检查。如果计算分支形成循环，读取会抛错。输入变化解除循环后，直接读取和捕获过该错误的上层订阅都能恢复。

模块副本内的 computed 追踪属于该副本自己的节点。跨 bundle、跨版本副本或其他实现的输入使用 `Readable<T>` 协议，通过显式 `bridge(owner, source)` 进入本地依赖图。`BridgeOwner` 只需要 `defer`；桥接订阅由调用方 Lifetime 拥有，没有跨副本全局 collector。

bridge 在订阅后重新读取以封闭挂接窗口。所有者退出时取消外部订阅、通知本地依赖失效并清除保存的值。现有订阅会收到一次终止通知，包括在批处理中关闭的情况。投递前主动撤销的订阅会跳过这次通知。退出后调用 get 或 subscribe 会抛错。

连接完成后，源读取失败也会使桥接值失效：本地读取抛出源错误；下一次成功读取会恢复，即使值与上次成功时相同。

`observe(owner, source, observer)` 按源值创建子所有者。替换时先完整退出旧子树，再创建新的子树；多个变化在进行中的切换间合并为最新值。返回的 `AsyncDisposable` 可以提前结束观察。并发和重复关闭共用同一次释放及其结果。若初次观察回调同步关闭所有者，构造会在启动后台任务前失败。

公开类型：`Readable`、`Signal`、`ReadonlySignal`、`Disposable`、`AsyncDisposable`、`BridgeOwner`、`ObservationOwner`、`ObservationTask`、`Observer`。`ObservationOwner` 只需提供 `defer`、`child` 和 `spawn`；它返回的子所有者实现标准异步释放协议。父所有者无需公开释放入口。

观察只需要知道排空任务何时结束。`ObservationTask` 没有类型参数，`result` 为 `PromiseLike<unknown>`；`spawn` 接收返回 `void | PromiseLike<void>` 的任务。拥有更多能力的泛型 `spawn` 和携带结果数据的 Task 仍可通过这个窄协议接入，观察不会解释任务的结果载荷。原先显式使用 `ObservationTask<T>` 的类型声明需要移除类型参数。

observer 自身同步登记资源，需要异步工作的回调显式 `generation.spawn`。抛出的失败由该观察任务的所有者报告，旧代次退出失败不会静默启动新代次。

`observe` 默认推断值、子所有者和回调结果类型，普通无返回回调与 `value => values.push(value)` 都可使用。显式声明 `Observer<T, Child>` 或只给 `observe<T, Child>` 两个类型参数时，结果默认为同步 `void`；需要保留其他同步返回类型的声明应给出第三个 `Result`，或让调用自行推断。不要把异步回调标记为 `void` 来绕过类型检查。

适配器在接入时捕获读取、订阅和取消订阅的方法。观察在接管子所有者、任务和清理句柄时，也会保存各自的释放方法。如果自定义所有者返回的任务可以取消，但没有有效的 `result`，或读取它时抛错，观察创建失败，回滚会调用已接管的任务释放方法。取消订阅失败后，该失败仍然是所有者的释放义务；提前结束观察、排空失败和后续退出都不能通过重复调用将其变成成功。

## 异步结果协议

同步边界检查和异步释放使用同一份结果协议。原型链包含当前模块所在 realm 的 `Promise.prototype` 时，选择原生协议，由内建 `then` 验证品牌并观察实际结算。自有 `then` 不能替代结算，已经履约的载荷也不会再次被解析。`constructor` 或 `Symbol.species` 的失败会原样传播，不会因此重试公开 `then`。子所有者、排空任务和所有者注册的关闭都加入这个实际结果，只有释放完成后才允许替换或宣告观察结束。

其他对象按结构协议处理：只捕获一次公开 `then`，保留调用 receiver，并遵循标准的递归解析语义。`Symbol.toStringTag` 不参与协议选择，带有 `"Promise"` 展示标签的结构 Promise 可以正常接入。

这明确收窄了跨 realm 的承诺：普通外部 Promise 通过合法的公开 `then` 接入；不会推断它的内部原生品牌。隐藏或改变该协议的外部 Promise，需要先在来源 realm 适配为正常结果。如果其履约载荷不能再次被解析，应在来源 realm 把载荷放入普通数据回执，再交给本模块。
