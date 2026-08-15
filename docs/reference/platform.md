# Dougong Platform 设计规范

`@dougongjs/platform` 负责把外部 Plugin 的 Manifest、加载、版本约束、激活策略和权限决策编译为 `@dougongjs/core` 的普通 Plugin 与 ChangeSet。它不是第二套执行引擎：Service 图、Lifetime、Group 所有权、回滚和 Instance 状态的最终真相仍只有 Core 一份。

本文描述 Platform 的可观察契约。Core 原语见 [Core API 规范](./core-api.md)，整体分层理由见[整体架构](./architecture.md)；面向使用者的介绍见[外部插件分发](../guide/platform.md)。

## 一、心智模型

Platform 只增加四个生命周期名词；Loader 与 Authorizer 保持为狭窄策略端口：

```text
Manifest       静态身份、兼容范围、激活条件和权限请求
Artifact       Manifest + 模块 Reference + 配置 + 可选占位 Plugin
Registration  一份 Artifact 进入 Platform 后的稳定身份
Platform       注册表、加载策略、权限策略和原子变更所有者
```

典型使用：

```ts
const platform = createPlatform({
  installer: host,
  apiVersion: "1.0.0",
  loader: new ImportLoader(),
  authorizer: new PermissionSet(["network"]),
});

const registration = await platform.register({
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
await registration.ready();
```

`register()` 只让 Artifact 进入 Platform；`activate()` 才选择并加载外部 Plugin；`ready()` 等待对应 Core Installation 真正越过 Host / ChangeSet ready barrier。三者不是近义 API。

## 二、Manifest

```ts
interface Manifest {
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
- 返回对象、数组和依赖映射都冻结；Manifest 是值，不持有执行状态。
- `Manifest.name` 是 Registration 身份，也必须与 placeholder 及加载模块的 `Plugin.name` 完全一致。

`apiVersion` 约束应用代码公开给 Plugin 的 Dougong/领域 API，不等同于 Plugin 自身版本。`dependencies` 约束其他 Manifest 的版本；Service 能力依赖仍必须写进 Core `requires`，不能把 Manifest 依赖当作 Service 图的旁路。

## 三、Loader 是执行边界

```ts
interface Loader<Reference> {
  load(reference: Reference, signal: AbortSignal): unknown | Promise<unknown>;
}
```

Loader 返回的模块必须以 `default` 导出唯一的 `Plugin`。Platform 在加载后重新走 `definePlugin()` 的结构校验，并核对 name。加载错误统一包装为 `PlatformError` 的 `MODULE_LOAD_FAILED`；模块形状或默认导出错误使用 `MODULE_INVALID`。

内置实现：

- `ImportLoader`：使用动态 `import()`，用于受信任的同 Realm ESM；明确**不是沙箱**。
- `MemoryLoader`：复制应用代码提供的只读 Map 并从中取模块，用于嵌入式 bundle、确定性测试和应用内建插件；它拒绝 `null`、数组等类型声明并未接受的输入。

Loader 必须在耗时阶段检查 `AbortSignal`。Platform 也会在 Loader 返回后再次检查，因此一个不合作的 Loader 不能在取消后把模块提交进 Core，但它自身已发生的 I/O 或模块顶层副作用无法撤销。

不可信 Plugin 应使用 Worker、iframe、独立进程或受限 Realm。相应 Loader 可以返回一个**应用代码编写的 RPC 代理 Plugin**，把获准能力映射成普通 Service；不能先在应用 Realm `import()` 任意代码，再指望 Context 权限把它变安全。

## 四、权限是策略端口，不是伪沙箱

```ts
interface Authorizer {
  authorize(manifest: Manifest, signal: AbortSignal): void | Promise<void>;
}
```

`PermissionSet` 是不可变 allow-list：允许项和 Manifest 权限使用同一非空、无首尾空白的标识符规则；未声明权限的 Manifest 通过；请求列表中只要有一个不在 allow-list，就抛带冻结 `denied` 列表的 `PermissionDeniedError`。Platform 未传策略时使用空 `PermissionSet`，即对所有显式权限请求 fail closed。

授权发生在两个边界：

1. 注册或变更 Artifact 时做 admission authorization；若有 placeholder，保证它进入 Core 前已经获准。
2. 每次真正加载外部模块前再次授权，使可撤销、交互式或随会话变化的策略能够阻止执行。

Authorizer 决定“是否允许继续”，不改写 Context，也不承诺操作系统级隔离。文件系统、网络、窗口等能力仍应由应用代码以最小 Service 接口提供；安全边界由 Loader、执行环境和 Service 实现共同完成。

## 五、注册、占位与激活

Artifact：

```ts
interface Artifact<Reference> {
  readonly manifest: ManifestInput | Manifest;
  readonly reference: Reference;
  readonly config?: unknown; // ConfigInput 非 void 时在类型上为必填
  readonly placeholder?: Plugin;
}
```

`placeholder` 必须由应用代码信任的代码创建。它适合在懒加载前贡献命令标题、菜单元数据或占位面板。Platform 注册时把它作为普通 Core Plugin 安装；激活时原子更新**同一个 Core Installation**，换成加载所得 Plugin，因此 Installation ID、Group 归属和下游观测身份保持稳定。

`Registration.status`：

| status | 含义 |
| --- | --- |
| `pending` | 仍由未提交的 Platform ChangeSet 拥有，尚未进入注册表 |
| `registered` | Artifact 已登记，外部 Plugin 尚未选中；placeholder 可能已在 Core 中 |
| `loading` | 正在授权、激活依赖或加载模块 |
| `activated` | 外部 Plugin 已提交到 Core；不代表 Host 此刻一定处于 `active` |
| `failed` | 最近一次激活失败；保留错误供诊断，允许再次显式 `activate()` |
| `removed` | 已从 Platform 与 Core 安装计划移除，不可复活 |

`activate()` 在 Host 为 `idle` 时也可以完成：它负责把加载所得 Plugin 提交进安装计划，不偷偷启动 Host。此时 `status === "activated"`，但先前或随后调用的 `ready()` 仍会等待 `host.start()`；这明确分开“Registration 已激活”和“Instance 已就绪”。

取消加载时只把 `signal.reason` 或明确的 `AbortError` 识别为取消结果。Loader 仅仅在 signal 已 abort 后抛出的其他错误仍保留为 `MODULE_LOAD_FAILED` 及其 `cause`，不会被竞态中的取消原因覆盖。

`ready()` 在 `pending` / `registered` / `loading` 时等待首次激活及 Core ready barrier；在 `activated` 时委托当前 Core Installation；在 `failed` / `removed` 时立即拒绝。一次失败的等待不会因以后重试自动复活，重试成功后应重新调用 `ready()`。

## 六、Manifest 依赖与激活条件

`platform.trigger(event)` 激活所有 Manifest `activation` 包含该字符串的 Registration。它会尝试全部匹配项；一个失败不取消无关 Registration。只有一个失败时原样抛出，多个失败时抛 `AggregateError`。

激活一个 Registration 前，Platform 按 Manifest 声明先激活依赖：

- 缺失依赖：`REGISTRATION_DEPENDENCY_MISSING`；
- 版本不满足：`REGISTRATION_DEPENDENCY_INCOMPATIBLE`；
- 依赖环：`REGISTRATION_CYCLE`。

注册顺序不需要等于依赖顺序：尚未激活的 Registration 可以暂时引用尚不存在的依赖，方便应用代码先收集一批 Manifest。但一旦所有节点出现，任何闭环都会在注册/变更的候选图阶段立即拒绝，不把 Registration 静默留在永久 pending 状态。

同一个 Registration 的激活串行化；多个消费者并发要求同一依赖时，该依赖只会完成一次有效加载。更新、移除和 Platform dispose 会取消并等待相关激活，不允许加载结果越过变更边界后“复活”旧 Artifact。

## 七、Platform ChangeSet

Platform 的声明变更同样只有一个 canonical primitive：

```ts
const change = platform.change();
change.update(provider, providerV2Artifact);
change.update(consumer, consumerV2Artifact);
change.remove(legacy);
const extra = change.register(extraArtifact);
await change.commit();
```

`platform.register()`、`registration.update()`、`registration.remove()` 都机械退化为单项 Platform ChangeSet。ChangeSet one-shot、commit 幂等、同一目标只允许出现一次，并拒绝其他 Platform 的 Registration。

空 Platform ChangeSet 提交为无副作用 no-op，不触发候选图、Core ChangeSet 或诊断 revision。

`change.register()` 创建的 Registration 在 commit 前只是该 ChangeSet 的 draft，不持有 Platform owner，也不能另行 `activate/update/remove`。commit 时才授予控制权限；注册失败后再次撤销。这样草稿不会绕开候选图，也不会因一个被遗忘的未提交 Registration 反向保活 Platform。

`commit()` 返回后立即调用 `activate()` 也不依赖微任务顺序：Registration 会先等待授权它的同一次提交，提交失败则两者观察到同一失败。

提交顺序：

1. 锁定并取消待更新/删除目标的飞行中激活；
2. 在当前注册表上一次应用全部操作，形成候选 Registration 图；
3. 检查重复身份和依赖环；对最终仍为 activated 的 Registration，要求全部依赖存在、版本兼容且已经 activated；
4. 对新增/更新 Manifest 执行授权；
5. 预加载所有 activated 目标的新 Plugin，任何失败都尚未触碰 Core；
6. 把 placeholder 安装、活动 Plugin 更新和删除编译进**一份 Core ChangeSet**并提交；
7. Core 成功后一次切换 Platform 的 Artifact、Registration 与诊断状态。

内部实现同样按这条边界拆分：Artifact 编译器只负责 Manifest、placeholder 和加载模块的信任校验；CandidateGraph 只验证完整候选依赖图；CoreChange 编译器只生成一份 Core ChangeSet 及其确定的 Artifact 终态。Platform 协调器在 Core 提交前准备好不会失败的本地提交闭包，因而不会在 Core 已成功后才发现缺失 Installation 或非法 Registration 状态。

这使提供者 `1.x → 2.x` 与消费者依赖范围 `^1 → ^2` 能在一份变更中完成；分两次 `update()` 时第一份非法候选图会被拒绝。模块 import 的顶层副作用不具备事务性，但安装计划、Core Instance 和 Registration 不会出现半提交状态。

若 Core 因配置、Service 图、setup 或清理失败拒绝已经准备好的更新，Registration 仍指向旧 Artifact 与旧 Manifest；Core 自己的 rollback / fail-closed 语义决定 Installation 最终恢复为 `active`，还是整个 Host 退回 `idle`，Platform 不伪造第二种恢复状态。

## 八、Group 与应用适配

`createPlatform()` 接受 `Installer`，因此既能绑定整个 Host，也能绑定某个 Group：

```ts
const workspace = host.group("workspace", () => {});
const platform = createPlatform({ installer: workspace, ...options });
```

Platform 安装的 placeholder 与加载所得 Plugin 都归该 Group 所有；删除 Group 会用一份 Core 事务删除整棵安装子树。Group 不是能力 Scope：Service、ExtensionPoint 与 Event 始终是 Host-wide。工作区数据区分应进入领域 Service/Contribution，安全隔离应使用独立 Host、Worker、iframe 或进程。

Dougong 也不定义万能适配基类。应用适配器就是普通的能力提供插件：

```ts
const filesystemAdapter = definePlugin({
  name: "application.filesystem",
  provides: { filesystem: FILESYSTEM },
  setup: () => ({ filesystem: createRestrictedFilesystem() }),
});

host.install(filesystemAdapter);
```

Planet 式媒体源、Lynx Desktop 式命令/菜单/面板分别是 ExtensionPoint；播放器、文件系统、窗口和存储是 Service；工作区/主题变化是 Event 或 Service 内的 Signal。领域包可以提供更贴近业务的建模函数，但必须机械展开为这些原语。

## 九、诊断、封装与释放

`platform.diagnostics` 使用与 Core/Signal 相同的 `get() + subscribe()` 只读协议，包含：

- Platform `apiVersion`、`status` 和单调 `revision`；
- 每个 Registration 的 `manifestName`、`version`、`status`、`activation`、`permissions`、`dependencies` 与最近错误。

快照、条目和数组冻结，Map 不暴露可变方法。`subscribe()` 只发送未来失效通知，调用方收到后重新 `get()`。诊断订阅者失败经 Platform Logger 上报，不会改变注册或激活结果。

Platform 不实现另一套观察器；它把不可变 PlatformSnapshot 提交给 Core 的 `SnapshotPublisher`。Platform 成功释放后，已经取得的历史 view 停在 `disposed` 终态，现有订阅被摘除，且 reader、Logger 和 Platform owner 都被切断。

Registration 和 PlatformChangeSet 都是冻结的 opaque facade 对象。即使在 JavaScript 中也不会泄露内部 Artifact、Core Installation、Platform owner 或候选图；Platform 通过私有 WeakMap 验证其权限。

Registration 进入 `removed` 后会撤销控制权限，并释放 Artifact reference、配置和 Platform owner；保留终态 Registration 不会反向保活整个 Platform。此时 `remove()` 仍幂等成功，`activate/update` 以 `REGISTRATION_REMOVED` 拒绝，与 Core Installation 的终态语义一致。

Platform 自身拥有全部 Registration：

```ts
await platform.dispose();
// 也支持 await using / Symbol.asyncDispose
```

释放是同一条变更队列里的终态命令：它先禁止新操作与新的 draft authority，等待此前变更，取消飞行中加载，再用一份 Core ChangeSet 原子移除全部 Core Installation。成功后 Platform 进入 `disposed`，全部 Registration 进入 `removed`；重复释放是幂等的。若 Core 清理失败，Platform 恢复为 `active` 并把错误抛给调用方，不谎报已经释放。

成功释放还会切断 Installer、Loader、Authorizer、Logger 端口和共享 draft authority。此前创建但未提交的 ChangeSet 之后只会以 `PLATFORM_UNAVAILABLE` 拒绝；其 draft Registration 进入 `failed` 并释放 Artifact，因此长期保留它们也不会继续保活 Host。

推荐的所有权顺序是先释放 Platform、再删除其绑定 Group；若应用代码已经先删除 Group，Platform 会识别已由 Core 移除的 Installation 并仍可幂等完成自身释放，不尝试通过已移除 Group 再创建一份空变更。

## 十、稳定错误码

Platform 的可判定错误使用 `PlatformError.code`。`PlatformError extends DougongError`，因此应用代码既能统一捕获 Dougong 全层错误，也能只处理分发层错误：

| code | 含义 |
| --- | --- |
| `MANIFEST_INVALID` | Manifest 形状、semver 或范围非法 |
| `API_INCOMPATIBLE` | Manifest 要求的应用 API 范围不匹配 |
| `PERMISSION_DENIED` | 权限策略拒绝；具体类型是 `PermissionDeniedError` |
| `REGISTRATION_DUPLICATE` | 候选 Registration 图出现重复身份 |
| `ARTIFACT_IDENTITY` | Manifest、placeholder 或加载所得 Plugin 的 name 不一致 |
| `REGISTRATION_IDENTITY` | 更新时新 Artifact 的 Manifest name 与原 Registration 不同 |
| `REGISTRATION_DEPENDENCY_MISSING` | activated/待激活 Registration 缺少 Manifest 依赖对应的 Registration |
| `REGISTRATION_DEPENDENCY_INCOMPATIBLE` | 依赖 Registration 的版本不满足 Manifest 范围 |
| `REGISTRATION_DEPENDENCY_INACTIVE` | activated 候选 Registration 依赖尚未 activated 的 Registration |
| `REGISTRATION_CYCLE` | 候选 Registration 图中的 Manifest 依赖存在闭环 |
| `REGISTRATION_BUSY` | 激活与同一目标的声明变更发生竞争 |
| `MODULE_LOAD_FAILED` | Loader 自身失败 |
| `MODULE_INVALID` | 模块或默认导出不是合法 Plugin |
| `REGISTRATION_REMOVED` | 对已移除的 Registration 操作 |
| `REGISTRATION_UNAVAILABLE` | Registration 尚未提交或不可用；activation / admission 抛出非 `Error` 值时，首次公开命令和 `ready()` 使用同一分类。未提交的终态 Registration 只保留错误摘要，因此后续 `ready()` 会重建等价错误而不保留原始 Error stack |
| `PLATFORM_UNAVAILABLE` | Platform 正在释放或已经释放 |

错误消息用于人读，不是稳定解析协议。编程形状错误、跨 Platform Registration、重复 ChangeSet 目标和 submitted 后继续修改使用 `TypeError`。
