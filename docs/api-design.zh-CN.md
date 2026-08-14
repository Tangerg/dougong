# Dougong API 设计规范

本文是 Core 公共 API 的规格书。[architecture.zh-CN.md](./architecture.zh-CN.md) 回答「为什么这样分层」，本文回答「每个 API 精确做什么、在边界上做什么」。

规则以可判定为标准书写：读者应当能仅凭本文预测运行时行为，而不需要读实现。凡实现与本文不一致之处，一律记在最后一节「已知偏差」，不在正文中含糊带过。

当前阶段允许 breaking change。规则冲突时以本文为准，实现应当追平本文。

## 目录

- [一、总原则：单路径](#一总原则单路径)
- [二、契约](#二契约)
- [三、插件定义](#三插件定义)
- [四、安装与依赖图](#四安装与依赖图)
- [五、启动与停止](#五启动与停止)
- [六、在线变更](#六在线变更)
- [七、Lifetime 与所有权](#七lifetime-与所有权)
- [八、Extension](#八extension)
- [九、Event](#九event)
- [十、Signal](#十signal)
- [十一、命名与语法风格](#十一命名与语法风格)
- [十二、可展开原则](#十二可展开原则)
- [十三、Core API 预算](#十三core-api-预算)
- [十四、心智模型](#十四心智模型)
- [十五、已知偏差与待决问题](#十五已知偏差与待决问题)

---

## 一、总原则：单路径

> 同一抽象层、同一种语义，只允许一个正式入口。高层语法糖必须编译到这个入口，不能拥有第二套生命周期、依赖图、观察协议或错误模型。

这不是「API 越少越好」。它要求的是：**同一种语义没有近义词竞争**。两个名字做同一件事，读者就必须先学会区分它们，而这份区分成本是永久的。

| 语义 | 唯一入口 | 不提供 |
| --- | --- | --- |
| 安装插件 | `app.install()` | `use` / `apply` / `load` / `registerPlugin` |
| 发布 Service | `provides` + `setup()` 返回值 | `ctx.provide` / `app.provide` / `setService` |
| 贡献扩展 | `ctx.contribute()` | `register` / `add` / `append` / `extend` |
| 监听事件 | `ctx.on()` | `listen` / `subscribeEvent` / `hook` |
| 发送事件 | `ctx.emit()` | `dispatch` / `publish` / `fire` |
| 注册清理 | `ctx.cleanup()` | `effect` / `using` / `own` / `defer` / `onDispose` |
| 启动后台任务 | `ctx.spawn()` | `run` / `task` / `fork` |
| 创建子生命周期 | `ctx.lifetime()` | `scope` / `child` / `fiber` |
| 读取当前值 | `source.get()` | `getSnapshot` / `value` / `current` / 函数调用形式 |
| 订阅变化 | `source.subscribe()` | `watch` / `observeChanges` / `listen` |
| 响应值变化并管理资源 | `ctx.observe()` | `effect` / `watchEffect` / `autorun` / `reaction` |
| 更新插件实例 | `handle.update()` | `replace` / `reload` / `reconfigure` / `restart` |
| 移除插件实例 | `handle.remove()` | `uninstall` / `delete` / `disposePlugin` |
| 释放资源句柄 | `handle.dispose()` | 可调用 disposer 函数 / `close` / `destroy` / `off` |

两个词的分工必须固定，不得混用：

- `remove()` 表示**从安装计划中删除一个插件实例**，是声明层操作。
- `dispose()` 表示**释放一个资源句柄**，是运行时操作。

---

## 二、契约

### 2.1 规则

`service` / `extension` / `event` 是同一种「声明契约」的语法：

```ts
const DATABASE = service<Database>("app/database");
const ROUTES = extension<Route>("http/routes");
const USER_CREATED = event<User>("users/created");
```

统一约束：

- 第一个参数永远是稳定 ID，且是契约的**唯一身份**。
- 返回值永远是冻结对象，形状为 `{ id, kind }`。
- 契约自身不持有任何运行时状态，因此可以在模块顶层声明、跨应用共享。
- 类型参数永远表示该契约承载的数据。
- Core 不提供接受裸字符串的替代 API。

`optional()` 是唯一的可选性修饰，只能包裹 Service：

```ts
const cache = optional(CACHE);
```

### 2.2 边界情形

**契约身份是字符串，不是对象。** 在两个模块里分别写 `service<A>("app/db")` 和 `service<B>("app/db")`，运行时视为同一个契约，而 TypeScript 不会报错——两处的类型参数会各自生效，其中一处必然是错的。

> 规则：一个契约 ID 在整个代码库中只允许声明一次，并从单一模块导出。ID 命名建议带命名空间前缀（`app/`、`http/`）以降低碰撞概率，但前缀不是身份的一部分，没有任何运行时含义。

**ID 必须非空且首尾无空白。** `service("")`、`service("  ")`、`service(" a")`、`service("a ")` 全部抛 `TypeError`。这是为了让 ID 可以安全地用于拼接（见 [8.2](#82-边界情形)）和日志输出。

**同一 ID 不允许承担两种 kind。** 同一 ID 先后作为 `service` 和 `extension` 出现时抛 `CONTRACT_CONFLICT`。

> 检测时机取决于该 ID 何时被观察到：`provides` / `requires` 中的契约在构建依赖图时被观察，而 `event` 与运行时的 `contribute` 目标在**首次调用** `on` / `emit` / `contribute` 时才被观察。因此一个「事件 ID 与服务 ID 撞车」的错误，可能要等到某个插件真的发出该事件时才报出来。这是可接受的：kind 冲突是编码错误，报出的时机不影响修复方式。

**`optional()` 只接受 Service。** 传入 Extension、Event 或非契约对象抛 `TypeError`。语义上这是必然的：Extension 永远存在（空集合也是集合），Event 没有提供者概念，二者都不存在「可选」这一维度。

---

## 三、插件定义

### 3.1 规则

插件只有一种形态：

```ts
const usersPlugin = definePlugin({
  name: "app.users",
  config: usersConfigSchema,
  requires: {
    db: DATABASE,
    cache: optional(CACHE),
    routes: ROUTES,
  },
  provides: {
    users: USERS,
  },
  setup(ctx, config) {
    const users = createUsers({ db: ctx.db, cache: ctx.cache });

    ctx.contribute(ROUTES, "users.show", {
      method: "GET",
      path: "/users/:id",
      handler: (request) => users.find(request.params.id),
    });

    return { users };
  },
});
```

不提供函数形式、class 形式或 `{ apply() }` 形式。三种形态会导致配置来源、生命周期返回值、插件身份和类型推导各自分叉，文档必须解释三套写法。对象形式已经足够简单，且更适合承载稳定元数据。

即使插件什么都不提供，结构不变：

```ts
const loggerPlugin = definePlugin({
  name: "app.logger",
  setup(ctx) {
    ctx.on(USER_CREATED, (user) => {
      ctx.log.info("user created", { id: user.id });
    });
  },
});
```

`definePlugin()` 在**定义期**完成全部结构校验，而非等到安装或启动。这把一整类错误的暴露时点提到了最早。

### 3.2 配置的输入类型与输出类型是两个类型

`config` 是一个 Standard Schema，因此存在输入与输出之分：

```ts
readonly config?: StandardSchemaV1<ConfigInput, Config>;
```

- `app.install(plugin, x)` 的 `x` 是 **ConfigInput**。
- `setup(ctx, config)` 的 `config` 是 **Config**（校验后的输出）。

二者可以不同。schema 做转换时这是唯一正确的建模：

```ts
const schema: StandardSchemaV1<string, number> = {
  /* "42" -> 42 */
};
app.install(parser, "42"); // 传入 string
// setup 收到 number
```

未声明 `config` 时，`setup` 原样收到 `install` 传入的值，不做任何处理。

### 3.3 边界情形

**校验清单。** 以下情形在 `definePlugin()` 抛 `TypeError`：

| 情形 | 原因 |
| --- | --- |
| `name` 非字符串、为空、或首尾有空白 | name 参与实例 ID 拼接 |
| 缺少 `setup` 或 `setup` 非函数 | 插件必须有主体 |
| `config` 存在但不实现 Standard Schema | 早于安装期发现 |
| `requires` 的键为空字符串 | 键即 Context 上的属性名 |
| `requires` 的键命中 Context 保留字 | 见下 |
| `requires` 的值不是 Service / Extension / `optional(Service)` | 类型之外的运行时兜底 |
| `provides` 的值不是 Service | Extension 与 Event 无法被「提供」 |

**Context 保留字。** `requires` 的键不得为：`signal`、`meta`、`log`、`cleanup`、`lifetime`、`spawn`、`observe`、`on`、`emit`、`contribute`。这十个是 Context 自身的 API。

> 保留字之外的键不做限制。把依赖命名为 `toString` 是合法的——它会在 Context 对象上遮蔽 `Object.prototype.toString`。由于 Context 只被插件读取，从不被框架反射，这没有实际后果。不建议这么做，但不构成错误。

**`requires` 与 `provides` 会被浅冻结复制。** 定义返回后再修改原始对象不影响插件。定义本身也被冻结。因此一个 `PluginDefinition` 是纯值，可以安全地跨多个 App、多个实例复用。

**未声明 `provides` 时 `setup` 的返回值被忽略。** 类型上 `setup` 的返回类型是 `void`，而 TypeScript 允许向 `void` 位置返回任意值，因此 `setup: (ctx) => ({ anything })` 能通过类型检查。运行时不读取它。这不是错误，但返回值没有任何用途。

**提供服务的插件事实上是单例。** 同一个 Service 契约只允许一个提供者（见 [4.3](#43-边界情形)）。因此一个带 `provides` 的插件被安装两次会直接导致 `SERVICE_CONFLICT`。需要多实例的能力应当由一个提供者管理一个内部集合，而不是安装多次。

> 与之相对，**只贡献 Extension 的插件可以安全地多实例化**，因为贡献键按实例隔离（见 [8.2](#82-边界情形)）。这个不对称是有意的：Service 是唯一能力，Extension 是开放集合。

---

## 四、安装与依赖图

### 4.1 规则

```ts
const app = createApp({ name: "example" });
const handle = app.install(usersPlugin, usersConfig);
```

`install()` 同步返回 `PluginHandle`，但**注册是排队的**。安装、更新、移除、启动、停止全部进入同一条串行命令队列，按调用顺序执行。

实例 ID 为 `` `${plugin.name}:${index}` ``，`index` 是应用内自增计数。因此同一插件的多个实例身份互不相同。

`PluginHandle`：

```ts
interface PluginHandle<Config, Requires, Provides, ConfigInput> {
  readonly id: string;
  readonly status: PluginStatus; // pending | active | stopping | failed | removed
  ready(): Promise<void>;
  update(update: { plugin?: PluginDefinition; config?: ConfigInput }): Promise<void>;
  remove(): Promise<void>;
}
```

### 4.2 依赖图的构成规则

图由 `requires` / `provides` 推导，规则**只有四条**：

1. 每个 Service 契约至多一个提供者。
2. 必需 Service 依赖：提供者 → 消费者建一条边。
3. **可选 Service 依赖：提供者存在时，同样建边。**
4. Extension 依赖：**不建边**。

第 3 条是全文最容易被误解的一条，单独展开：

> `optional(CACHE)` 的含义是**「CACHE 不存在时我也能启动」**，不是**「我不关心 CACHE 的生命周期」**。
>
> 一旦 CACHE 有了提供者，消费者就是它的依赖者：启动时排在它之后，它重启时消费者一并重启，它被移除时消费者也要重启（这次 `ctx.cache` 将是 `undefined`）。
>
> 这是唯一自洽的语义。若不建边，消费者会持有一个已被销毁的服务实例的引用。

第 4 条同样是刻意的：

> Extension 是**活集合**，其内容变化是数据变化，不是图变化。消费者通过订阅得到新快照，不需要重启。若 Extension 也建边，任何一个插件贡献一条路由都会重启整个 HTTP 服务器。

### 4.3 边界情形

**启动顺序是确定的。** 拓扑排序在每一步都按 install 序号取最小者出队。相同的安装顺序永远得到相同的启动顺序。关停顺序是启动顺序的逆序。

**四种图错误，全部在停止任何实例之前抛出：**

| 错误码 | 触发条件 |
| --- | --- |
| `SERVICE_CONFLICT` | 两个实例提供同一个 Service |
| `SERVICE_MISSING` | 必需 Service 无提供者 |
| `SERVICE_CYCLE` | 插件依赖自己提供的 Service，或存在依赖环 |
| `CONTRACT_CONFLICT` | 同一 ID 承担两种 kind |

环错误的消息会列出环上的全部实例 ID。自依赖单独报错，因为它的成因（写错了 alias）与多点环完全不同。

**可选依赖缺失时值为 `undefined`。** 类型上 `ResolvedRequirement<OptionalService<T>>` 是 `T | undefined`，因此调用点必须处理。

**Extension 依赖永远可解析。** 即使没有任何插件贡献过，消费者也会拿到一个空 `ReadonlyMap` 的视图。不存在「Extension 缺失」这种状态。

**在未启动的应用上 `install()` 只登记，不启动。** `handle.status` 保持 `pending`，`ready()` 返回的 Promise 挂起，直到 `app.start()` 使其激活。

**`remove()` 是幂等的但不是零成本的。** 对已移除的实例再次调用 `remove()` 不会报错，但若应用处于 `active`，它仍会走一次完整的变更事务（计算出的受影响集合为空，因此不会停止或启动任何东西）。

---

## 五、启动与停止

### 5.1 规则

```ts
await app.start();
await app.stop();
```

- `start()` 在应用已 `active` 时是无操作。
- `stop()` 在应用已 `idle` 时是无操作。
- 启动按拓扑序**串行**执行。
- 关停按启动序的逆序执行，聚合全部错误。

### 5.2 为什么启动暂时串行

依赖图已经具备并行启动互不依赖节点的条件。保持串行是因为并行调度会引入并发上限、失败取消、日志顺序和回滚竞态四类策略，而目前没有任何真实性能数据来选择它们。计划执行器可以在不改变任何插件 API 的前提下替换。

在有测量数据之前，确定性比吞吐更值钱。

### 5.3 边界情形

**启动失败后应用回到 `idle`，且不会自行恢复。** 全部非 `active` 的实例被标记为 `failed`，错误从 `start()` 抛出。此后即使安装新插件补齐了缺失的服务，应用也**不会自动启动**——必须再次显式调用 `start()`。

> 这条规则的反面（用一个「期望已启动」的布尔值驱动）会产生一种令人困惑的行为：启动抛错了，然后装一个插件，应用自己起来了。应用的实际状态是唯一事实来源。

**`setup()` 未返回已声明的服务时抛 `SERVICE_NOT_RETURNED`。** 判定条件是返回值必须是非 `null` 对象且 `Object.hasOwn(output, alias)` 为真。返回 `undefined`、返回缺少某个 alias 的对象、以及把值放在原型上，都会失败。

**`setup()` 抛错时，该实例已注册的资源会被释放。** 释放本身若再抛错，二者被合并为 `IncompletePluginCleanupError` 向上抛出，并触发更严格的失败处理（见 [6.3](#63-失败处理有两级)）。

**服务值在提供者的实例上是唯一绑定的。** 内部记录的是「服务 → (提供者实例, 值)」而非「服务 → 值」。停止一个旧实例时只会删除**由它自己**注册的绑定，不会误删新实例已经发布的同名服务。

---

## 六、在线变更

这是全文语义最密集的一节。**在线变更**指应用处于 `active` 时的 `install()` / `update()` / `remove()`。

### 6.1 算法

1. 保存旧安装声明、旧解析配置、旧依赖图。
2. 在声明层应用变更，构建新依赖图（此步会抛出 [4.3](#43-边界情形) 的四种图错误）。
3. 沿**旧图和新图各展开一次**「变化节点 + 全部传递依赖者」，取并集，得到受影响集合。
4. 校验受影响集合内全部实例的配置。
5. **至此仍未停止任何东西。** 以上任一步失败，回滚声明层，抛错，运行时完全未受触动。
6. 按旧图逆序，只停止受影响的实例。
7. 按新图拓扑序，只启动受影响的实例。
8. 失败时按 [6.3](#63-失败处理有两级) 处理。

### 6.2 为什么必须在两张图上展开

一条依赖边可能只存在于其中一张图里：

- **新装一个提供者**：新消费者到它的边只在新图中存在。旧图里那个消费者是「可选依赖缺失」状态，没有任何边。
- **移除一个提供者**：边只在旧图中存在。新图里消费者已经没有这个依赖了。

只看一张图，两种情形之一必然漏掉需要重启的消费者，使其继续持有失效引用。

### 6.3 失败处理有两级

变更失败时，运行时可能处于两种性质不同的状态，因此有两条不同的处理路径：

**回滚（rollback）** —— 失败的新实例已被**干净地**释放。此时按旧计划重建同一闭包，应用回到变更前的状态并保持 `active`，原始错误向上抛出。

**失败关闭（fail closed）** —— 出现以下任一情况：

- 停止阶段有实例清理失败；
- 启动阶段失败，且其部分运行时无法被干净释放（`IncompletePluginCleanupError`）。

此时**停止整个应用并进入 `idle`**，把全部原因聚合为 `AggregateError` 抛出。

> 为什么不冒险重启：一个清理未完成的实例可能仍持有端口、文件锁或连接池。在它之上重新启动同一个插件，第二次获取同一资源会以一种和本次变更完全无关的方式失败。一个名义 `active`、实际残缺的应用比一个明确 `idle` 的应用危险得多。

回滚本身也失败时，同样退到 `idle`，并把变更错误、回滚错误和关停错误一并聚合。

### 6.4 这不是数据库事务

本节保证的是**受控的生命周期变更与失败恢复**，不是隔离性。插件对外部系统产生的不可逆副作用（已发出的 HTTP 请求、已写入的文件、已投递的消息）不会被回滚。这类副作用应当由插件自身避免，或通过幂等协议处理。

### 6.5 边界情形

**未受影响的插件全程不重启。** 它们的 Lifetime、服务实例和 Extension 贡献全部原样保留。

**受影响插件的 Extension 贡献会经历「消失再出现」。** 贡献由 Lifetime 拥有，重启即先释放后重建。由于停止与启动之间存在 `await` 边界，微任务会被冲刷，**订阅者会实际观察到一个不含这些贡献的中间快照**。

这是当前行为，且是可预测的。消费者若不能容忍中间态，应当在自己的订阅回调里做防抖，或依据快照内容判断是否处于重建过程中。Core 不为此在变更两端加 `batch()`——那会把「重启期间集合短暂为空」这一真实情况隐藏起来。

**配置校验发生在停止之前。** 一个拼错的配置只会得到 `ConfigValidationError`，运行中的实例不会被停掉再靠回滚捞回来。

**`stop()` 后紧跟的 `update()` 会以离线方式生效。** 命令队列保证顺序：`stop()` 先执行完，随后的 `update()` 看到的是 `idle` 状态，于是只更新声明并把实例置为 `pending`，不启动任何东西。下次 `start()` 时使用新配置。

**在线 `install()` 失败时不返回错误给调用方。** `install()` 返回的是 Handle 而非 Promise。失败会记录在实例上，通过 `handle.status === "failed"` 或 `await handle.ready()` 的拒绝获取。若该次失败触发了失败关闭，整个应用会退到 `idle`，而 `install()` 的调用点对此没有直接的同步信号——必须检查 `app.status`。

---

## 七、Lifetime 与所有权

### 7.1 规则

监听器、贡献、后台任务、观察过程、子 Lifetime 和普通 cleanup，最终都归属于某个 Lifetime。

Context 与子 Lifetime 使用**同一套**资源 API：

```ts
ctx.cleanup(fn);
ctx.lifetime();
ctx.spawn(task);
ctx.observe(source, observer);
ctx.on(event, listener);
ctx.contribute(extension, key, value);
```

```ts
const session = ctx.lifetime();
session.cleanup(fn);
session.spawn(task);
session.on(event, listener);
await session.dispose();
```

不提供 `child()` / `scope()` / `fork()` / `effect()` / `resource()`。统一叫 `lifetime()`，因为它表达的就是**时间所有权**，不暗示依赖注入作用域、线程或进程。

释放是 **LIFO**、**幂等**、**聚合错误**的。

### 7.2 三态状态机

```text
active → disposing → disposed
```

| 阶段 | 可以获取新资源 | 可以 `emit` |
| --- | --- | --- |
| `active` | 是 | 是 |
| `disposing` | **否** | **是** |
| `disposed` | 否 | 否 |

`disposing` 阶段允许 `emit` 是刻意的：**发出一个「我要下线了」的事件是极自然的需求**，而 `emit` 本身不注册任何资源，禁止它没有任何收益。

反过来，`disposing` 阶段禁止获取新资源同样是必须的：此时释放循环已经在遍历资源列表，新注册的资源会落在一个不会被再次遍历的位置，永远泄漏。

### 7.3 `ctx.observe()` 的精确语义

```ts
ctx.observe(source, (value, lifetime) => {
  // 为当前 value 同步建立资源
});
```

语义固定为六条：

1. 立即读取一次并同步执行回调。
2. `source` 变化后，**先销毁上一次的子 Lifetime**，再用最新值创建新的子 Lifetime 并执行回调。
3. 连续变化会合并，只处理最新值。
4. 回调**必须同步**；异步工作使用 `lifetime.spawn()`。
5. 宿主 Lifetime 结束时，当前子 Lifetime 自动销毁。
6. `source` 只需满足结构化的 `Readable` 协议，不必是 Dougong Signal。

典型用法：

```ts
const endpoint = computed(() => `${baseUrl.get()}/events/${accountId.get()}`);

ctx.observe(endpoint, (url, lifetime) => {
  const socket = new WebSocket(url);
  lifetime.cleanup(() => socket.close());
});
```

多个依赖先用 `computed()` 组合，而不是让 `observe` 接受多个源：

```ts
const request = computed(() => ({ query: query.get(), page: page.get() }));

ctx.observe(request, (input, lifetime) => {
  lifetime.spawn((signal) => search(input, { signal }));
});
```

这里没有依赖数组、没有隐式清理、没有 async 回调、没有插件 `setup` 重执行。

### 7.4 为什么不提供裸 `effect(fn)`

```ts
// 不提供
effect(() => {
  connect(endpoint.get());
  report(user.get());
});
```

问题不在自动追踪本身，而在于：依赖是隐式的、重执行时机是隐式的、资源清理边界是隐式的、异步任务容易竞态、Signal 写入可能成环，且插件作者无法判断某次执行是初始化还是响应。

`observe` 把输入变成显式的单一 Signal，把资源边界变成显式的子 Lifetime，代价只是必须先写一个 `computed`。

### 7.5 边界情形

**`spawn` 的任务错误只在非取消时上报。** 任务因 Lifetime 释放而被中止时抛出的错误被吞掉——那不是故障，是预期的取消。其他错误经由 `log.error` 上报。

**`spawn` 返回的 `Task` 的 `dispose()` 会等待任务真正结束。** 它先 abort，再等待 `result` 落定（无论成功或失败）。因此 Lifetime 的释放会等待其后台任务收敛，不会留下悬挂的异步工作。

**`observe` 的回调返回 thenable 时抛 `TypeError`。** 返回的 Promise 会被接住并上报，避免未处理拒绝，随后仍然抛错。这是刻意的严格：一个 async 回调意味着「上一次资源尚未清理完，下一次已经开始」，而这正是 `observe` 要消除的竞态。

**`observe` 的初始回调抛错会使 `observe()` 本身抛错。** 订阅被撤销、子 Lifetime 被释放，且不会留下任何已注册资源。在 `setup` 中调用时，这会让插件启动失败——这是正确的：初始状态都建立不起来的插件不应当被视为已激活。

**`observe` 只在值真正变化时重跑。** 调度器在微任务中重新读取 `source.get()`，与上次的值做 `Object.is` 比较，相等则不做任何事。因此一次「设置成相同的值」不会导致资源重建。

**Lifetime 释放时 `AbortSignal` 先于清理回调触发。** `dispose()` 同步执行 abort，资源释放循环在随后的微任务中开始。因此监听 `ctx.signal` 的代码总是先于 `ctx.cleanup()` 注册的回调得到通知。

**父 Lifetime 的 abort 会级联到子 Lifetime 的 signal，但不会调用它们的 `dispose()`。** 子 Lifetime 由父的资源列表持有，在释放循环中被正常释放。二者的区别在时序：signal 立即翻转，`dispose()` 按 LIFO 顺序稍后执行。

---

## 八、Extension

### 8.1 规则

Core 只提供一种 Extension：

```ts
const ROUTES = extension<Route>("http/routes");
```

所有 Extension 在底层都是**由插件拥有的、带稳定局部键的动态贡献集合**。

贡献的签名永远是三参数：

```ts
const route = ctx.contribute(ROUTES, "users.show", {
  method: "GET",
  path: "/users/:id",
  handler,
});

route.update(next);
route.dispose();
```

消费者拿到的视图满足统一的可观察协议：

```ts
interface ExtensionView<T> extends ReadonlySignal<ReadonlyMap<string, T>> {}
```

```ts
const routes = ctx.routes.get();

for (const route of routes.values()) {
  // ...
}
```

Core **不提供** `extension.keyed()` / `extension.many()` / `extension.ordered()` / `extension.override()`。

### 8.2 边界情形

**贡献键按实例隔离。** 运行时把局部键与**插件实例 ID**组合成全局键：

```text
app.users:3/users.show
```

因此：

- 不同插件使用相同局部键不冲突。
- **同一插件的不同实例**使用相同局部键也不冲突。
- 同一实例、同一局部键只能有一个贡献，重复贡献抛 `TypeError`。
- 插件停止时只删除自己拥有的贡献。
- 旧 Handle 无法影响后来创建的实例。

> 组合进的是实例 ID 而非插件名。若只用插件名，同一插件的两个实例会互相冲突，而 [3.3](#33-边界情形) 已经说明只贡献 Extension 的插件应当可以安全多实例化。

**局部键必须非空且首尾无空白。** 与契约 ID 同样的约束，且理由相同：它参与全局键的拼接。

**快照是真正不可变的。** `get()` 返回的对象实现 `ReadonlyMap` 接口但**没有** `set` / `delete` / `clear`。把它 `as Map` 强转后也无法修改。这不是类型上的礼貌，是运行时的保证。

**每次贡献变化都产生一个新快照对象。** 因此 `Object.is(prev, next)` 可用于判断集合是否变化，这也是 `ctx.observe(ctx.routes, ...)` 能正确去重的基础。

**`update()` 在值未变化时不发布新快照。** 以 `Object.is` 比较。因此用同一个对象引用反复 `update` 不会惊动订阅者。

**`update()` 在贡献已释放后抛 `TypeError`；`dispose()` 幂等。** 这个不对称是有意的：重复释放是无害的常见写法，而向一个已消失的贡献写值一定是逻辑错误。

**Extension 消费者不会因贡献者重启而重启**，但会观察到贡献的消失与重现（见 [6.5](#65-边界情形)）。

### 8.3 键控、排序与覆盖属于更高层

命令系统需要按 `command.id` 唯一、中间件需要排序、主题需要后来者覆盖且卸载后恢复旧值——这些都不是 Extension Core 的责任：

```text
Extension<Command>   + keyOf(c => c.id)      + 冲突策略   = CommandCatalog Service
Extension<Middleware> + orderBy(m => m.order) + compose()  = HTTP Pipeline
Extension<Theme>     + keyOf(t => t.id)      + stack 策略 = ThemeCatalog Service
```

这才是「原子 API 组合形成高级能力」的实际形态：高层组合器读取 Extension 的快照，施加自己的语义，再作为一个 Service 对外提供。它们不需要 Core 增加任何开关。

---

## 九、Event

### 9.1 规则

```ts
ctx.on(EVENT, listener);
await ctx.emit(EVENT, payload);
```

只有这一套派发语义：

- 异步。
- 广播给全部监听器。
- 并发执行。
- 等待全部完成。
- 聚合全部错误为 `AggregateError`。
- 不返回业务结果。

不提供 `once()` / `parallel()` / `serial()` / `bail()` / `waterfall()` / `dispatch()` / `publish()`。

需要顺序和返回值的处理链使用 Extension，而不是给 Event 增加第二种模式：

```ts
const PIPELINE = extension<Middleware>("http/pipeline");
```

`once()` 可以是纯高层函数，无需 Core 支持：

```ts
function once(ctx, event, listener) {
  const subscription = ctx.on(event, async (value) => {
    subscription.dispose();
    return listener(value);
  });
  return subscription;
}
```

### 9.2 后台发送

`emit()` 返回的 Promise 在任一监听器失败时拒绝。当发送方并不关心结果时，**不引入 `emitDetached()`，而是组合已有原子**：

```ts
ctx.spawn(() => ctx.emit(INDEX_INVALIDATED, { path }));
```

`spawn` 会接住失败并经由 `log.error` 上报，因此不会产生未处理拒绝。

> 这里存在一个真实的人体工学代价：最常见的用法需要一层包装。这是为了保住「`emit` 只有一种含义」而付出的价格。若改为默认吞掉错误，就必须再提供一个「等待并聚合错误」的变体，Event 便有了两套语义——那个代价更大且是永久的。

### 9.3 边界情形

**监听器集合在 `emit` 开始时被快照。** 因此：

- 在 `emit` 期间新增的监听器**不会**收到本次事件。
- 在 `emit` 期间被释放的监听器**仍会**收到本次事件。

这保证了一次 `emit` 的接收者集合是确定的，不受监听器自身副作用影响。

**监听器的返回值被忽略，但会被等待。** 返回 Promise 的监听器会被 `emit` 等待。返回其他值不构成错误，只是没有用途。

**没有监听器时 `emit` 立即成功。** 不是错误。事件是广播的事实，没有听众不改变事实成立。

**关停顺序决定谁能听到最后的事件。** 在 `cleanup` 中 `emit` 是允许的（见 [7.2](#72-三态状态机)），但监听方若排在发送方之前被释放，就已经不在监听器集合里了。关停是启动顺序的逆序，因此**先安装的插件后释放**——想在关停时接收事件的监听者，应当比发送者更早安装。

**事件没有作用域过滤。** 一个 App 内的 Event 是全局广播的，不存在子树隔离。需要隔离的场景应当把区分维度放进 payload，由监听者自行过滤。

---

## 十、Signal

### 10.1 Signal 不是第五种能力令牌

Signal 解决的是「一个值会持续变化，其他计算和消费者需要读取它的当前状态」。

| 模型 | 语义 | 有契约令牌 |
| --- | --- | --- |
| Service | 插件实例内稳定的能力 | 是 |
| Extension | 动态增减的贡献集合 | 是 |
| Event | 不保留的瞬时事实 | 是 |
| Signal | 保留当前值、可订阅变化 | **否** |
| Lifetime | 上述监听、任务、资源的所有权 | 否 |

**不存在 `signal("app/theme")` 这样的能力令牌。** Signal 是一种**值类型**，不是接线机制。跨插件共享一个 Signal 必须借道 Service：

```ts
interface NetworkService {
  readonly online: ReadonlySignal<boolean>;
  setOnline(value: boolean): void;
}

const NETWORK = service<NetworkService>("app/network");
```

Service 负责能力边界，Signal 负责能力内部的动态状态。

> 这个不对称是刻意的，也必须被理解：五个原语不是同一种东西。前三个是**声明式接线**，Signal 是**数据类型**，Lifetime 是**所有权维度**。把 Signal 也做成令牌，会让「依赖必须声明」这条规则出现一个不经过依赖图的旁路。

### 10.2 两个协议，一个是另一个的子集

```ts
// 结构协议：任何外部 store 都能满足
interface Readable<T> {
  get(): T;
  subscribe(listener: () => void): Disposable;
}

// Dougong 自己的响应式节点，带只有本模块能签发的品牌
interface ReadonlySignal<T> extends Readable<T> {
  readonly [brand]: true;
}

interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
}
```

区别只有一条，但这条是关键的：

> **`computed()` 只自动追踪 `ReadonlySignal`。`Readable` 不被自动追踪。**

`ctx.observe()` 接受 `Readable`，因为它走的是显式 `subscribe()`，对任何实现都正确。

品牌的作用是防止用户手写一个 `Readable` 却以为它能被 `computed` 跟踪——那会得到一个永不失效的缓存值，无报错、无警告。类型层面禁止伪装，把这个失败模式变成编译错误。

### 10.3 读写形式

```ts
const count = signal(0);

count.get();
count.set(count.get() + 1);
```

选择 `.get()` / `.set()` 而非 Solid 的 `count()`：

- 是普通对象，容易发现和调试。
- 不会与「值本身就是函数」的 Signal 混淆。
- Extension 视图、状态句柄、框架适配器可以共用同一协议。
- 与 TC39 Signals 草案的方向一致——该草案同样认为 effect、调度和所有权更依赖框架，不应与 Signal 图强行绑定。

React 适配层可以把 `get()` 映射到 `useSyncExternalStore` 需要的 `getSnapshot`，**Core 完全不知道 React**。

### 10.4 三个原子

```ts
signal(initial);
computed(calculate);
batch(callback);
```

不提供 `memo()` / `derive()` / `selector()` / `computedValue()`——统一叫 `computed()`。

不提供 `effect()` / `watch()` / `watchEffect()` / `autorun()` / `reaction()` / `createRoot()` / `onCleanup()` / `useSignal()`。

不做深层 Proxy Store。Signal 只观察整个值：

```ts
const user = signal({ name: "Ada", age: 20 });

user.set({ ...user.get(), age: 21 });
```

这比 Vue 式深层代理更可预测，也更适合前端、后端与桌面程序共用同一套语义。

### 10.5 `computed` 为什么可以自动追踪

因为它被约束为：同步、纯计算、惰性、有缓存、不创建资源、无外部副作用。

自动依赖追踪被限制在纯值计算里，就不会控制插件生命周期。副作用一侧由 `observe` 显式承担。这是整套响应式设计的支点。

### 10.6 边界情形

**`set()` 相同值不通知。** 以 `Object.is` 比较。`NaN` 视为等于自身，`+0` 与 `-0` 视为不同——这与 `Object.is` 一致，而非 `===`。

**`computed` 是惰性的：无人读取则从不计算。** 首次 `get()` 才求值。无订阅者时不订阅上游，仅在读取时按版本号校验依赖是否变化。

**`computed` 的依赖是动态的。** 每次求值重新收集，不再被读取的依赖会被解除订阅。因此 `computed(() => a.get() ? b.get() : c.get())` 在条件为真时不会因 `c` 变化而失效。

**`computed` 自引用抛 `TypeError: Circular computed signal`。** 求值过程中再次进入同一个 `computed` 即触发。

**首次求值失败的 `computed` 不会保留订阅者。** `subscribe()` 时若初始求值抛错，监听器会被移除、上游订阅被解除，然后抛出。下一次 `subscribe()` 会重新尝试求值。这避免了一个「已订阅但从未成功计算」的僵死状态。

**订阅者的错误被聚合，不中断其他订阅者。** 一个监听器抛错不会阻止其余监听器收到通知；全部执行完毕后错误被聚合抛出。因此 `signal.set()` 本身可能抛错，且此时值**已经更新**。

**`batch()` 内的通知被合并到出批时统一冲刷。** 支持嵌套，只有最外层出批才冲刷。回调与冲刷各自抛错时，二者被合并为 `AggregateError`。抛出 `undefined` 也能被正确传播（不依赖 `!== undefined` 判定）。

**没有重入保护。** 在监听器里 `set()` 另一个 Signal 会同步触发下一轮通知。写成环会栈溢出。`batch()` 可以把一次操作内的多次写入合并，但不阻止跨轮次的循环。这是刻意的：加入环检测意味着要定义「一轮」的边界，而那会引入调度器。

---

## 十一、命名与语法风格

整套 API 遵守同一套文法。

**定义名词**（返回一个值，无副作用）：

```ts
service();
extension();
event();
optional();
definePlugin();
createApp();
```

**修改运行时状态的动词**：

```ts
install();
contribute();
on();
emit();
cleanup();
spawn();
observe();
update();
remove();
```

**读取与订阅**：

```ts
get();
subscribe();
```

**释放资源**：

```ts
dispose();
```

**控制应用**：

```ts
start();
stop();
```

近义词漂移必须避免。以下每组中只有一个词可以出现在同层 API 中：

```text
add / append / attach / bind / mount / register
remove / revoke / detach / unbind / unmount
run / execute / invoke / dispatch / trigger
get / read / snapshot / current / value
```

---

## 十二、可展开原则

> 任何高层 API 都必须可以机械展开成 Core API。

```ts
http.route({ id: "users.show", method: "GET", path: "/users/:id", handler });
// 必须等价于
ctx.contribute(HTTP_ROUTES, "users.show", { method: "GET", path: "/users/:id", handler });
```

```ts
commands.register(command);
// 必须等价于
ctx.contribute(COMMAND_CONTRIBUTIONS, command.id, command);
```

```ts
using(ctx, resource);
// 必须等价于
ctx.cleanup(() => dispose(resource));
```

即使是宿主提供的现成值，也走插件：

```ts
function value(token, instance) {
  return definePlugin({
    name: `value:${token.id}`,
    provides: { value: token },
    setup: () => ({ value: instance }),
  });
}

app.install(value(WINDOW, windowAdapter));
```

Runtime 不知道 `value()` 的存在，也没有专门的 value-provider 分支。

高层 API **可以**提供：默认值、Schema、键提取、排序、冲突策略、批处理、领域错误信息、更好的类型推导。

高层 API **不可以**：直接访问内部注册表、使用另一套生命周期、绕过变更事务、绕过所有权追踪、产生另一种 Handle、定义另一种错误模型。

### 12.1 高层能力从定义层接入

「可展开原则」约束的是**语法糖**。但权限、审计、沙箱、HMR 这类**能力**需要观察或改写插件的行为，而 Core 不提供任何运行时拦截点——Context 由 Core 内部构造并冻结，没有 waterfall、没有 `internal/*` 钩子。

这是刻意的：拦截点一旦存在，就等于承认存在第二条运行路径。

这类能力的正确接入位置是**定义层**：高层包变换 `PluginDefinition`，而不是插桩运行时。

```ts
function withPermissions(definition, policy) {
  return definePlugin({
    ...definition,
    setup: (ctx, config) => definition.setup(guard(ctx, policy), config),
  });
}

app.install(withPermissions(usersPlugin, policy), usersConfig);
```

`guard()` 只需要浅拷贝 Context 的自有属性并替换其中若干个，不需要 Proxy。Core 全程不知情，也不存在第二条运行路径——被安装的仍然是一个普通的 `PluginDefinition`。

同理，HMR 是「监听文件变化 → 调用 `handle.update({ plugin })`」，不需要 Core 提供 `reload()`。加载器是「读配置 → 调用 `install()`」，不需要 Core 理解 manifest。

> 判据：一个高层能力若无法表达为「变换定义」或「组合 Core 调用」，说明它需要的是 Core 缺失的原语，应当作为原语讨论，而不是作为拦截点加进来。

---

## 十三、Core API 预算

### 顶层

```ts
createApp;
definePlugin;
service;
extension;
event;
optional;
```

### Context 固有属性

```ts
signal; // AbortSignal
meta; // { app, name, instance }
log; // Logger
```

### Context 操作

```ts
cleanup;
lifetime;
spawn;
observe;
on;
emit;
contribute;
```

### Application

```ts
name;
log;
status;
install;
start;
stop;
```

**Application 不提供 `get(token)`。** 一个能从应用直接取服务的入口，等于给「依赖必须声明」开了后门：拓扑图将不再是依赖关系的完整真相，而重启闭包正是从这张图算出来的。需要某个服务，就声明它。

### Plugin Handle

```ts
id;
status;
ready;
update;
remove;
```

### Resource Handle

```ts
dispose;
```

### 响应式包

```ts
signal;
computed;
batch;
```

这是一个可以长期守住的预算。任何新增都应当先证明它无法由现有原语组合得到。

---

## 十四、心智模型

三句话应当足以预测绝大多数运行时行为：

```text
插件通过 requires 获得能力，
通过 setup 的返回值提供 Service，
通过 contribute 加入开放扩展。
```

```text
通过 Context 创建的监听、贡献、任务和 cleanup，
自动属于创建它们的 Lifetime。
```

```text
Service 变化重建消费者，
Extension 变化通知订阅者，
Event 只广播本次事实。
```

第二句的限定词「**通过 Context 创建的**」不可省略。

> 一个通过 Service 方法注册的回调——`ctx.someService.onChange(cb)`——**不属于任何 Lifetime**。提供方并不知道调用方是谁，Core 也不会去追踪它。这类订阅必须由调用方自己交给 Lifetime：
>
> ```ts
> const subscription = ctx.someService.onChange(cb);
> ctx.cleanup(() => subscription.dispose());
> ```
>
> 这是显式契约换来的代价：没有 Proxy，就没有调用方归属追踪。设计上接受这一点，但文档不能把它说成已经解决。服务作者可以主动缓解——让注册方法接受一个 Lifetime 参数，把所有权还给调用方：
>
> ```ts
> interface SomeService {
>   onChange(lifetime: LifetimeContext, cb: () => void): void;
> }
> ```

最终原则：

> 每种语义只有一个原子入口；高层能力只能组合或包装这个入口，不能平行发明另一套机制。API 名称、返回 Handle、观察协议、生命周期和错误语义必须在所有层保持同构。

---

## 十五、已知偏差与待决问题

### 15.1 实现与本文的偏差

| 项 | 本文规定 | 当前实现 | 影响 |
| --- | --- | --- | --- |
| `ExtensionView` | `extends ReadonlySignal<ReadonlyMap<string, T>>` | `extends Readable<...>` | 类型上不可被 `computed()` 追踪，但运行时可以（`get()` 透传到内部 Signal）。类型比运行时保守，不会产生错误结果，但会让「从多个 Extension 派生组合视图」显得不可行。 |
| 契约 kind 的提交时机 | 变更成功后才写入全局表 | 图构建通过后即写入 | 一次最终被回滚的变更若引入了新的契约 ID，该 `ID → kind` 绑定会残留。后续以另一种 kind 合法使用同一 ID 会被拒。窄，但确为状态泄漏。 |

### 15.2 刻意未提供

- **`app.group()`**：分组语法看似只是命名，实则必须先回答四个问题——分组是否构成服务命名空间边界；组内插件能否看见组外的 Service，反之如何；分组是否是依赖图上的节点；删除分组时成员的贡献如何处理。这四个答案不同，`group()` 就是四个不同的特性。在给出答案之前不写进 API 预算，因为一个只有名字的条目会让人误以为隔离问题已有设计。

- **服务作用域隔离（isolate）**：多租户、多工作区、沙箱子树是真实需求，但目前 Core 是单一扁平命名空间。它与 `group()` 是同一个待决问题的两面。

- **并行启动**：见 [5.2](#52-为什么启动暂时串行)。

- **运行时拦截点**：见 [12.1](#121-高层能力从定义层接入)。

### 15.3 Effect-TS 的位置

Effect-TS 与 Dougong 的能力重合几乎是全面的：

| Dougong | Effect-TS |
| --- | --- |
| Service / requires / provides | Context / Layer |
| Lifetime / cleanup | Scope / acquireRelease |
| spawn / AbortSignal | Fiber / interruption |
| 插件依赖图 | Effect requirements |
| Event / Signal | PubSub / Ref / SubscriptionRef |
| 普通 Promise、throw | `Effect<Success, Error, Requirements>` |

把它放进 Core 只有两个结果：同时保留两套模型（架构分裂），或完全改成 Effect 模型（Dougong 变成 Effect 的上层包装，不再是普通 JS 插件框架）。二者都不符合「JS 习惯、低心智负担、同层唯一 API」。

正确方式是单向适配器，且不新增插件形态：

```ts
ctx.spawn(toTask(effectProgram));
```

而不是：

```ts
defineEffectPlugin(/* ... */);
```

Effect 用户可以在业务 Service 内部自由使用 Effect，Core 仍然只理解普通任务、`AbortSignal` 和 `Disposable`。

### 15.4 关于 `effect` 这个词

生态里 `effect` 至少有三个互不兼容的含义：

1. 旧式 Cordis 的 `ctx.effect()`——资源注册与销毁收集器，不是响应式概念。
2. Solid 的 `createEffect()`——自动追踪、值变即重执行。
3. Effect-TS——一整套程序运行时。

Dougong 的公共 API **彻底不使用这个词**，拆成 `cleanup()`、`spawn()`、`lifetime()`、`observe()` 四个各自精确的名字。这是[第一节](#一总原则单路径)的原则在概念层面的执行：三个含义共用一个词，是最严重的一种近义词竞争。
