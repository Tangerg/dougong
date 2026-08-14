# Dougong Platform 设计规范

`@dougongjs/platform` 负责把外部插件的 manifest、加载、版本约束、激活策略和权限决策编译为 `@dougongjs/core` 的普通插件与 ChangeSet。它不是第二套插件运行时：Service 图、Lifetime、Group 所有权、回滚和实例状态的最终真相仍只有 Core 一份。

本文描述 Platform 的可观察契约。Core 原语见 [api-design.zh-CN.md](./api-design.zh-CN.md)，整体分层理由见 [architecture.zh-CN.md](./architecture.zh-CN.md)。

## 一、心智模型

Platform 只增加四个概念：

```text
Manifest       静态身份、兼容范围、激活条件和权限请求
Artifact       Manifest + 模块引用 + 配置 + 可选占位定义
ManagedPlugin  一个外部插件在平台中的稳定管理身份
Platform       注册表、加载策略、权限策略和原子变更所有者
```

典型使用：

```ts
const platform = createPlatform({
  container: app,
  apiVersion: "1.0.0",
  loader: new ImportPluginLoader(),
  permissions: new PermissionSet(["network"]),
});

const plugin = await platform.register({
  manifest: {
    name: "music.remote",
    version: "1.2.0",
    apiVersion: "^1.0.0",
    activation: ["command:music.search"],
    permissions: ["network"],
  },
  reference: new URL("./remote-plugin.js", import.meta.url),
});

await platform.trigger("command:music.search");
await plugin.ready();
```

`register()` 只让 Artifact 进入平台；`activate()` 才选择并加载它的外部实现；`ready()` 等待对应 Core 实例真正越过 Application / ChangeSet ready barrier。三者不是近义 API。

## 二、Manifest

```ts
interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly activation: readonly string[];
  readonly permissions: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}
```

`defineManifest(input)` 是唯一规范化边界，默认值为：

```ts
{
  apiVersion: "*",
  activation: ["startup"],
  permissions: [],
  dependencies: {},
}
```

规则：

- `name`、激活条件、权限名、依赖名和版本范围必须非空且首尾无空白；不做静默 trim。
- `version` 必须是完整语义版本；`apiVersion` 和每个依赖值必须是受支持的版本范围，`*` 明确表示任意版本。
- Manifest 是 strict object，未知字段拒绝，而不是悄悄丢弃拼错的配置。
- 同一激活条件或权限不得重复。
- 返回对象、数组和依赖映射都冻结；Manifest 是值，不持有运行时状态。
- 插件 `name` 是 Platform 身份，也必须与占位定义及加载模块的 `PluginDefinition.name` 完全一致。

`apiVersion` 约束宿主公开给插件的 Dougong/领域 API，不等同于插件自身版本。`dependencies` 约束其他 Manifest 的版本；真正的运行时能力依赖仍必须写进 Core `requires`，不能把 Manifest 依赖当作 Service 图的旁路。

## 三、Loader 是执行边界

```ts
interface PluginLoader<Reference> {
  load(reference: Reference, signal: AbortSignal): unknown | Promise<unknown>;
}
```

Loader 返回的模块必须以 `default` 导出唯一的 `PluginDefinition`。Platform 在加载后重新走 `definePlugin()` 的结构校验，并核对 name。加载错误统一包装为 `PlatformError` 的 `MODULE_LOAD_FAILED`；模块形状或默认导出错误使用 `MODULE_INVALID`。

内置实现：

- `ImportPluginLoader`：使用动态 `import()`，用于受信任的同 Realm ESM；明确**不是沙箱**。
- `MemoryPluginLoader`：从宿主提供的只读 Map 取模块，用于嵌入式 bundle、确定性测试和宿主内建插件。

Loader 必须在耗时阶段检查 `AbortSignal`。Platform 也会在 Loader 返回后再次检查，因此一个不合作的 Loader 不能在取消后把模块提交进 Core，但它自身已发生的 I/O 或模块顶层副作用无法撤销。

不可信插件应使用 Worker、iframe、独立进程或受限 Realm。相应 Loader 可以返回一个**宿主编写的 RPC 代理 PluginDefinition**，把获准能力映射成普通 Service；不能先在宿主 Realm `import()` 任意代码，再指望 Context 权限把它变安全。

## 四、权限是策略端口，不是伪沙箱

```ts
interface PermissionAuthorizer {
  authorize(manifest: PluginManifest, signal: AbortSignal): void | Promise<void>;
}
```

`PermissionSet` 是不可变 allow-list：未请求权限的插件通过；请求列表中只要有一个不在 allow-list，就抛带冻结 `denied` 列表的 `PermissionDeniedError`。Platform 未传策略时使用空 `PermissionSet`，即对所有显式权限请求 fail closed。

授权发生在两个边界：

1. 注册或变更 Artifact 时做 admission authorization；若有占位定义，保证它进入 Core 前已经获准。
2. 每次真正加载外部模块前再次授权，使可撤销、交互式或随会话变化的策略能够阻止执行。

Authorizer 决定“是否允许继续”，不改写 Context，也不承诺操作系统级隔离。文件系统、网络、窗口等能力仍应由宿主以最小 Service 接口提供；安全边界由 Loader/执行环境和 Service 实现共同完成。

## 五、注册、占位与激活

Artifact：

```ts
interface PluginArtifact<Reference> {
  readonly manifest: PluginManifestInput | PluginManifest;
  readonly reference: Reference;
  readonly config?: unknown; // ConfigInput 非 void 时在类型上为必填
  readonly placeholder?: PluginDefinition;
}
```

`placeholder` 必须由宿主信任的代码创建。它适合在懒加载前贡献命令标题、菜单元数据或占位面板。Platform 注册时把它作为普通 Core 插件安装；激活时使用同一个 Core Handle 原子更新成加载定义，因此 installation ID、Group 归属和下游观测身份保持稳定。

`ManagedPlugin.status`：

| status | 含义 |
| --- | --- |
| `pending` | 仍由未提交的 Platform ChangeSet 拥有，尚未进入注册表 |
| `registered` | Artifact 已登记，外部实现尚未选中；占位定义可能已在 Core 中 |
| `loading` | 正在授权、激活依赖或加载模块 |
| `activated` | 外部定义已提交到 Core；不代表 Application 此刻一定处于 `active` |
| `failed` | 最近一次激活失败；保留错误供诊断，允许再次显式 `activate()` |
| `removed` | 已从 Platform 与 Core 安装计划移除，不可复活 |

`activate()` 在 Application 为 `idle` 时也可以完成：它负责把定义提交进安装计划，不偷偷启动 Application。此时 `status === "activated"`，但先前或随后调用的 `ready()` 仍会等待 `app.start()`；这明确分开“模块已激活”和“运行实例已就绪”。

`ready()` 在 `pending` / `registered` / `loading` 时等待首次激活及 Core ready barrier；在 `activated` 时委托当前 Core Handle；在 `failed` / `removed` 时立即拒绝。一次失败的等待不会因以后重试自动复活，重试成功后应重新调用 `ready()`。

## 六、Manifest 依赖与激活条件

`platform.trigger(event)` 激活所有 manifest `activation` 包含该字符串的插件。它会尝试全部匹配项；一个失败不取消无关插件。只有一个失败时原样抛出，多个失败时抛 `AggregateError`。

激活一个插件前，Platform 按 manifest 声明先激活依赖：

- 缺失依赖：`PLUGIN_DEPENDENCY_MISSING`；
- 版本不满足：`PLUGIN_DEPENDENCY_INCOMPATIBLE`；
- 依赖环：`PLUGIN_CYCLE`。

注册顺序不需要等于依赖顺序：尚未激活的插件可以暂时引用尚未注册的依赖，方便宿主先收集一批 Manifest。但一旦所有节点出现，任何闭环都会在注册/变更的候选图阶段立即拒绝，不把插件静默留在永久 pending 状态。

同一个 ManagedPlugin 的激活串行化；多个消费者并发要求同一依赖时，该依赖只会完成一次有效加载。更新、移除和 Platform dispose 会取消并等待相关激活，不允许加载结果越过变更边界后“复活”旧 Artifact。

## 七、Platform ChangeSet

Platform 的声明变更同样只有一个 canonical primitive：

```ts
const change = platform.change();
change.update(provider, providerV2Artifact);
change.update(consumer, consumerV2Artifact);
change.remove(legacyPlugin);
const extra = change.register(extraArtifact);
await change.commit();
```

`platform.register()`、`managed.update()`、`managed.remove()` 都机械退化为单项 Platform ChangeSet。ChangeSet one-shot、commit 幂等、同一目标只允许出现一次，并拒绝其他 Platform 的 Handle。

空 Platform ChangeSet 提交为无副作用 no-op，不触发候选图、Core ChangeSet 或诊断 revision。

`change.register()` 创建的 ManagedPlugin 在 commit 前只是该 ChangeSet 的 draft，不持有 Platform owner，也不能另行 `activate/update/remove`。commit 时才授予控制权限；注册失败后再次撤销。这样草稿不会绕开候选图，也不会因一个被遗忘的未提交 Handle 反向保活 Platform。

提交顺序：

1. 锁定并取消待更新/删除目标的飞行中激活；
2. 在当前注册表上一次应用全部操作，形成候选 Manifest 图；
3. 检查重复身份和依赖环；对最终仍为 activated 的插件，要求全部依赖存在、版本兼容且已经 activated；
4. 对新增/更新 Manifest 执行授权；
5. 预加载所有 activated 目标的新定义，任何失败都尚未触碰 Core；
6. 把占位安装、活动定义更新和删除编译进**一份 Core ChangeSet**并提交；
7. Core 成功后一次切换 Platform 的 Artifact、Handle 与诊断状态。

内部实现同样按这条边界拆分：Artifact 编译器只负责 Manifest、占位定义和加载模块的信任校验；CandidateGraph 只验证完整候选依赖图；CoreChange 编译器只生成一份 Core ChangeSet 及其确定的 Artifact 终态。Platform 协调器在 Core 提交前准备好不会失败的本地提交闭包，因而不会在 Core 已成功后才发现缺失 Handle 或非法注册状态。

这使提供者 `1.x → 2.x` 与消费者依赖范围 `^1 → ^2` 能在一份变更中完成；分两次 `update()` 时第一份非法候选图会被拒绝。模块 import 的顶层副作用不具备事务性，但安装计划、Core 运行实例和 Platform 记录不会出现半提交状态。

若 Core 因配置、服务图、setup 或清理失败拒绝已经准备好的更新，ManagedPlugin 仍指向旧 Artifact 与旧 Manifest；Core 自己的 rollback / fail-closed 语义决定运行实例最终是恢复为 `active` 还是整个 Application 退回 `idle`，Platform 不伪造第二种恢复状态。

## 八、Group 与宿主适配

`createPlatform()` 接受 `PluginContainer`，因此既能绑定整个 Application，也能绑定某个 Group：

```ts
const workspace = app.group("workspace", () => {});
const platform = createPlatform({ container: workspace, ...options });
```

Platform 安装的占位与活动定义都归该 Group 所有；删除 Group 会用一份 Core 事务删除整棵安装子树。Group 不是能力 Scope：同一 Application 内的 Service、Extension 与 Event 保持全局一致。工作区数据区分应进入领域 Service/Contribution，安全隔离应使用独立 Application、Worker、iframe 或进程。

Dougong 也不定义万能 `Host` 基类。宿主适配器就是普通的能力提供插件：

```ts
const filesystemAdapter = definePlugin({
  name: "host.filesystem",
  provides: { filesystem: FILESYSTEM },
  setup: () => ({ filesystem: createRestrictedFilesystem() }),
});

app.install(filesystemAdapter);
```

Planet 式媒体源、Lynx Desktop 式命令/菜单/面板分别是 Extension；播放器、文件系统、窗口和存储是 Service；工作区/主题变化是 Event 或 Service 内的 Signal。领域包可以提供更贴近业务的建模函数，但必须机械展开为这些原语。

## 九、诊断、封装与释放

`platform.diagnostics` 使用与 Core/Signal 相同的 `get() + subscribe()` 只读协议，包含：

- Platform `apiVersion`、`status` 和单调 `revision`；
- 每个已注册插件的 name、version、status、activation、permissions、dependencies 与最近错误。

快照、条目和数组冻结，Map 不暴露可变方法。`subscribe()` 只发送未来失效通知，调用方收到后重新 `get()`。诊断订阅者失败经 Platform Logger 上报，不会改变注册或激活结果。

Platform 不实现另一套观察器；它把不可变 PlatformSnapshot 提交给 Core 的 `SnapshotPublisher`。Platform 成功释放后，已经取得的历史 view 停在 `disposed` 终态，现有订阅被摘除，且 reader、Logger 和 Platform owner 都被切断。

ManagedPlugin 和 PlatformChangeSet 都是冻结的 opaque handle。即使在 JavaScript 运行时也不会泄露内部 Artifact、Core Handle、Platform owner 或候选图；Platform 通过私有 WeakMap 验证 Handle 权限。

Handle 进入 `removed` 后会撤销控制权限，并释放 Artifact reference、配置和 Platform owner；保留终态 Handle 不会反向保活整个 Platform。此时 `remove()` 仍幂等成功，`activate/update` 以 `PLUGIN_REMOVED` 拒绝，与 Core PluginHandle 的终态语义一致。

Platform 自身拥有全部 ManagedPlugin：

```ts
await platform.dispose();
// 也支持 await using / Symbol.asyncDispose
```

释放先禁止新操作、取消飞行中加载，再用一份 Core ChangeSet 原子移除全部 Core Handle。成功后 Platform 进入 `disposed`，全部 ManagedPlugin 进入 `removed`；重复释放是幂等的。若 Core 清理失败，Platform 恢复为 `active` 并把错误抛给调用方，不谎报已经释放。

成功释放还会切断 container、loader、permission、logger 端口和共享 draft authority。此前创建但未提交的 ChangeSet 之后只会以 `PLATFORM_UNAVAILABLE` 拒绝，其 draft Handle 进入 `failed` 并释放 Artifact；它们不会因为被调用方长期保留而继续保活宿主 Application。

推荐的所有权顺序是先释放 Platform、再删除其绑定 Group；若宿主已经先删除 Group，Platform 会识别已由 Core 移除的 Handle 并仍可幂等完成自身释放，不尝试通过失效 Group 再创建一份空变更。

## 十、稳定错误码

Platform 的可判定错误使用 `PlatformError.code`。`PlatformError extends DougongError`，因此宿主既能统一捕获 Dougong 全层错误，也能只处理分发层错误：

| code | 含义 |
| --- | --- |
| `MANIFEST_INVALID` | Manifest 形状、semver 或范围非法 |
| `API_INCOMPATIBLE` | 插件要求的宿主 API 范围不匹配 |
| `PERMISSION_DENIED` | 权限策略拒绝；具体类型是 `PermissionDeniedError` |
| `PLUGIN_DUPLICATE` | 候选注册表出现重复 name |
| `PLUGIN_IDENTITY` | Manifest、占位定义或加载定义 name 不一致 |
| `PLUGIN_DEPENDENCY_MISSING` | activated/待激活插件缺少 Manifest 依赖 |
| `PLUGIN_DEPENDENCY_INCOMPATIBLE` | Manifest 依赖版本不满足 |
| `PLUGIN_DEPENDENCY_INACTIVE` | activated 候选插件依赖尚未 activated 的插件 |
| `PLUGIN_CYCLE` | Manifest 依赖图存在闭环 |
| `PLUGIN_BUSY` | 激活与同一目标的声明变更发生竞争 |
| `MODULE_LOAD_FAILED` | Loader 自身失败 |
| `MODULE_INVALID` | 模块或默认导出不是合法插件定义 |
| `PLUGIN_REMOVED` | 对已移除的 ManagedPlugin 操作 |
| `PLUGIN_UNAVAILABLE` | `ready()` 无法等待的兜底状态 |
| `PLATFORM_UNAVAILABLE` | Platform 正在释放或已经释放 |

错误消息用于人读，不是稳定解析协议。编程形状错误、跨 Platform Handle、重复 ChangeSet 目标和 submitted 后继续修改使用 `TypeError`。
