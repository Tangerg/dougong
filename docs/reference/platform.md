# Platform 规范

`@dougongjs/platform` 仅依赖 `dougong` 的正式公开入口。运行值导出 `createPlatform`、`defineManifest`、`MemoryLoader`、`ImportLoader`、`PermissionSet`、`PlatformError`、`PermissionDeniedError`。

类型导出：`Platform`, `PlatformOptions`, `PlatformStatus`, `Registration`, `RegistrationStatus`, `RegistrationSnapshot`, `PlatformSnapshot`, `Artifact`, `ArtifactInput`, `ArtifactDescriptor`, `ArtifactOrigin`, `Catalog`, `Manifest`, `ManifestInput`, `Loader`, `Authorizer`, `AdmissionRequest`, `ActivationOptions`, `ActivationPreviewOptions`, `ActivationPreview`, `ActivationBlocker`, `PlatformErrorCode`

## 目录、选择、执行

| 入口 | 行为 |
| --- | --- |
| `catalog.add(input)` | 捕获不可变的发行声明和配置 |
| `catalog.get(name, revision)` / `catalog.list()` | 查阅已知 Artifact |
| `catalog.remove(artifact)` | 移除发现记录 |
| `registrations()` | 枚举当前可用于命令的 Registration 句柄，返回冻结数组 |
| `select(artifacts)` | 整组接纳选择意图，按输入顺序返回冻结的 Registration 数组 |
| `preview(registrations, { remove })` | 数据层检查和延迟验证清单 |
| `activate(registrations, { remove, signal })` | 准入、加载并编译为一笔 Core Plan |
| `trigger(event, options)` | 从已选 Manifest 派生激活集合 |
| `remove(...registrations)` | 复用同一 Core Plan 执行移除 |
| `[Symbol.asyncDispose]()` | 取消待完成激活并移除该 Platform 拥有的执行 |

`PlatformOptions.id` 区分同一 Host 中的交付命名空间。可选 `group` 必须已提交并属于给定 Host。应用代码通过 `PlatformOptions.apiVersion` 提供应用 API 版本，Platform 捕获该版本并校验 `Manifest.apiVersion` 声明的兼容范围。Host 是 Core 的执行边界。

Artifact 的 `revision` 是调用方给定的内容或发行身份；没有依赖时钟生成的版本。复用要求同一已提交 Installation 上的 revision 和经验证的 Manifest 都与选择一致。依赖键、激活事件和权限的声明顺序不影响匹配。Registration 的 `selectionRevision` 用于拒绝过期激活。`activeOrigin` 由 Installation origin 派生，Core 提交通知中已经能够看到正确来源。

Artifact 的配置是安装或更新该发行物时使用的输入，不是持续覆盖 Core 的期望状态。应用通过 Core 单独更新配置后，如果 origin 仍匹配，后续激活会复用该 Installation，保留当前配置。需要交付新的配置时，添加并选择新的 Artifact 修订；Platform 不维护另一份可独立推进的运行配置。

发现与预览是同步操作；选择、激活、触发与移除始终返回 Promise，输入不合法也通过拒绝报告。事件匹配和计划捕获使用同一批已接纳的选择；即使调用方尚未 await，排在触发命令之前的选择也已生效。

`select` 在提交时捕获数组自己的索引数据，并在排队命令执行时重新检查整个集合的 Catalog 身份、可用性和名称唯一性。任一成员不合法，整组都不改变选择；空数组不改变任何选择。所有目标都完成选择后才通知诊断订阅者或取消过期操作。其他 Registration 保持原选择，移除须显式提交。接纳后的 Catalog 撤回不会撤销已经选择的意图。

Artifact 和 Registration 是由 Catalog、Platform 分别签发的名义句柄，普通结构对象不能作为这些句柄使用。运行时仍按对象身份检查所属 Catalog 或 Platform；类型标记不能证明某个句柄属于当前实例。Manifest、ArtifactInput 和诊断快照仍是数据声明或只读投影。

## 状态和边界

Platform 状态为 `active/disposing/disposed`。Registration 状态为 `selected/activating/removing/installed/failed/quarantined/removed`，反映选择、正在执行的操作及 Core 执行事实。调用方取消不会覆盖上次实际失败；当前选择激活成功后清除该错误。选择、激活目标及移除列表只捕获数组自己的索引数据。稀疏数组和访问器会被拒绝，不会调用 getter。

Platform 先登记激活操作并发布其投影，再接入调用方取消。取消登记重入关闭时，同一操作已经属于关闭流程，会在加载开始前取消；登记失败则结束这次操作并解除观察，不会留下阻止关闭完成的等待。

`RegistrationSnapshot` 的 `status` 与 `error` 保持关联：`failed` 必有错误，`selected/installed` 没有错误，`activating/removing/quarantined` 可以保留上次失败。当前快照不包含已移除的 Registration；`execution` 复用 Core `InstallationSnapshot` 的已提交状态范围，或在没有本 Registration 拥有的已提交 Installation 时为 `undefined`。活句柄的独立 getter 不保证跨读取的类型收窄；需要关联判断时，读取并使用同一份快照。

当 `status === "installed"` 时，同一快照的 `activeOrigin` 必为 `ArtifactOrigin`，`execution` 必为 `stopped`、`running` 或 `changing`；类型判别后可以直接读取来源。installed 表示已提交来源与选择一致，不能据此断言执行正在运行。来源与执行状态取自同一 Core 安装快照；其他 Registration 状态仍可能保留先前的已提交来源。

`status === "quarantined"` 与 `execution === "quarantined"` 在同一快照中双向成立；此时 `activeOrigin` 仍可能为 `undefined`。`execution === undefined` 时，`activeOrigin` 也必为 `undefined`；执行存在则不保证存在 Artifact 来源。

诊断快照在读取或被订阅观察时物化；没有观察者的连续选择不会反复遍历全部 Registration。未变化的快照保持同一对象身份，无关 Core 活动不会通知 Platform 观察者。订阅从当前状态建立比较基线，释放后保留最终快照并断开运行资源。

Host 诊断读取属于观察行为。读取失败传给读取方或通知错误报告器；它不能让已经提交的选择、激活返回命令失败，也不能阻止关闭流程取消已接纳的准备工作。

Platform 创建及加载、最终准入期间的 Host 诊断观察共用同一绑定协议，捕获订阅的同步释放方法及其接收者。接入方即使保存监听器后抛错，或返回缺失、不可读的释放方法，观察建立失败也会撤销本地绑定；构造失败的残留监听器不能经该绑定保留 Platform 的 loader、授权器或 logger。异步订阅句柄被立即拒绝，其拒绝结果会被观察。临时观察在启动对应加载或授权之前校验释放协议，并在调用外部解绑之前撤销本地回调；解绑失败后，残留监听器也不会保留已退出的 Platform 或再访问它的关闭边界。

准备与诊断解绑同时失败时，调用方收到按准备、解绑顺序保留两项原因的 `AggregateError`。取消请求不能掩盖独立失败；只有错误确实携带该请求的取消原因时才按取消处理，不会覆盖之前记录的实际失败。

Host 计划与执行回执也使用[统一异步结果协议](../guide/lifetime.md)。SDK 适配器装饰原生 Promise 的公开方法，不能替换 Core 签发的 Plan、提前结束激活或释放 Registration；激活、移除与关闭都等待 Core 的真实结算，并保留真实失败。

`Platform.status` 描述可用性，退出结果由 `[Symbol.asyncDispose]()` 返回的同一 Promise 表达。Core 移除完成后，Platform 终止可用性并撤销观察绑定；外部解绑回调读取时，实时状态和诊断快照已经同时反映终态。诊断解绑失败会使该回执拒绝，终态通知仍会投递。重复关闭保留原失败且不重试解绑。Core 移除被拒绝时仍保留原有 `active` 状态及选择，以便处理该拒绝。

`ActivationPreview.deferred` 明确包含 `admission`、`moduleValidation`、`configurationValidation`、`coreBinding`、`setup`。预览不是运行验证通过的凭证。activate 捕获选择版本与 Artifact 身份，准备完成后再次核对，过期结果不能覆盖新选择。

`ActivationBlocker["code"]` 仅包含发行依赖规划能产生的四种错误：`REGISTRATION_DEPENDENCY_MISSING`、`REGISTRATION_DEPENDENCY_INCOMPATIBLE`、`REGISTRATION_DEPENDENCY_INACTIVE`、`REGISTRATION_CYCLE`。加载、权限和 Core 执行错误不能作为预览 blocker；它们在各自的执行边界报告。

Manifest dependencies 负责发行依赖；Plugin requires 负责真实能力绑定。动态导入图属于 打包器的模块热替换适配器，不能从这两个图猜测。示例 12 展示将 bundler 影响集合提交为一笔激活计划。

Manifest 的输入、输出类型和冻结语义由同一验证 schema 定义。`defineManifest` 接受只读声明，返回值可以直接作为新的 Manifest 输入。合法 Registration 名称在依赖记录中同样有效，包括 `__proto__`、`constructor` 和 `toString`；这些名称按普通依赖边处理。

声明读取、校验及错误格式化失败统一报告 [`MANIFEST_INVALID`](errors.md)，并保留原始 `cause`。Zod 的错误映射和 locale 可能在首次读取失败结果时才执行，因此这部分求值同样属于验证边界。

提交 Core Plan 前，Platform 会为直接安装和更新的 Artifact 请求激活授权。如果该 Plan 还会重启本 Platform 拥有的其他 Artifact，授权使用其已提交的来源。如果无法从已提交的来源恢复匹配的 Manifest，或其 API 范围与当前 Platform 不兼容，整笔变更会在执行前被拒绝。显式将该 Registration 加入激活目标，可按当前选择重新安装。依赖规划失败会记录在本次选中且需要安装或更新的 Registration 上，调用 preview 则只读取状态。Core 接手计划后，如果需要回滚，可能沿用已提交版本原先的准入结果并再次执行其 setup。直接调用 Host 或经其他 Platform 提交的命令也不经过这个 Platform 的准入。

Platform 构造时捕获 Loader 和 Authorizer 的方法，并保留各自的接收对象。Loader 是结构协议；ImportLoader 用同一 realm 的动态导入，MemoryLoader 适合测试与受控模块表。PermissionSet 是声明权限集合的 Authorizer 实现，不提供操作系统隔离。

`ImportLoader` 实现 `Loader<string>`，只接受原始字符串模块定位值，在运行时同样拒绝 `URL` 及其他对象，不执行隐式字符串转换。应用在创建 Artifact 时用 `url.href` 捕获定位值；目标改变应通过新的 Artifact 修订表达。原生模块解析、缓存和求值的取消限制仍然适用，字符串定位值不代表内容完整性或执行隔离保证。见[加载引用示例](../guide/platform.md#在发行声明中捕获模块定位值)。

其他 `Loader<Reference>` 可以定义自己的不透明引用协议，包括对象身份。Platform 不深克隆这种引用；其含义、映射稳定性及完整性保证由对应 Loader 拥有，不能从泛型类型推断。

Authorizer 通过返回或兑现为 `undefined` 批准请求，通过抛错或拒绝 Promise 拒绝请求。两个准入阶段收到其他返回值时都会抛出 TypeError。现有 JavaScript 策略若返回布尔值，应改为条件为假时抛错，条件为真时正常返回。

Core 规划、最终准入、应用或释放期间，新的选择和激活命令以 [`PLATFORM_BUSY`](errors.md) 拒绝。释放 Platform 会取消尚在等待的规划和准入，即使验证器或授权回调本身正在等待这次释放。一旦 Platform 将 Plan 交给 Core 应用，或已开始释放 Core 安装，释放命令也以 [`PLATFORM_BUSY`](errors.md) 拒绝，避免 setup 或清理回调等待自己。此前已接纳的激活仍能完成，交接之前的加载保持并发。

在配置验证或最终准入期间取消，Platform 会结束等待并释放命令占用；迟到的结果不能提交。交给 `host.apply(plan, signal)` 后，调用方信号继续送达 Core。Engine 独占候选清理、实际结算、恢复和隔离，Platform 返回 Core 的真实结果，不用取消原因覆盖恢复失败或隔离错误。提交已经确定后，迟到取消不能改写成功结果。取消不能撤销模块副作用或外部 I/O。已没有已提交 Installation 的 Registration 仍可直接移除。

同一次激活失败所影响的 Registration 共享一份已脱离运行资源的错误快照。最后一个加载等待者离开时，会断开外部 Promise 到 Platform 后续操作的引用；即使适配器永不结束，成功释放后的 Platform 也不会因此保留 Artifact 或加载能力。

即使较早的请求仍在加载，Registration 状态也反映真正交给 Core 执行的命令；Platform 释放期间正在移除的安装显示为 `removing`。Manifest 依赖遍历使用显式栈，环诊断只包含实际闭环。Platform ID、Manifest 名称及依赖名称须为可编码的良构 Unicode。构造时一次捕获日志后端方法及其原始接收者。

激活在排队等待准入或提交期间可以立即取消，即使前面的命令仍在等待用户代码。取消通过私有从属信号送达，即使调用方拦截了原信号上的事件也能撤回等待。

最终准入期间，其他 Host 命令一旦推进提交版本，本次 Core Plan 即失效。Platform 会取消对授权回调的等待，并在目标 Host 被隔离或 Group 已移除时报告对应的目标错误。如果目标仍然可用，[`ACTIVATION_STALE`](errors.md) 会给出预期版本和当前版本，调用方可以重新激活。

加载授权和模块加载阶段也订阅目标有效性：Group 删除或 Host 隔离立即结束等待，即使适配器永不返回。此时分别报告 [`REGISTRATION_UNAVAILABLE`](errors.md) 或 [`PLATFORM_UNAVAILABLE`](errors.md)，并保留真实失败诊断。加载尚未绑定 Core Plan 的提交版本，所以不相关的 Host 提交不会令共享加载失效。
