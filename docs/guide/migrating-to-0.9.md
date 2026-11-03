# 从 0.8.3 迁移到 0.9.0

0.9.0 调整了包结构、安装变更、插件上下文和资源退出契约。升级需要修改调用代码；旧入口不提供别名或兼容适配器。[Release Notes](../reference/release-0.9.0.md) 列出本次发布的完整范围。

## 1. 调整依赖与导入

```sh
pnpm add dougong@0.9.0
```

直接依赖旧 Core 包的应用，应从依赖清单中删除 `@dougongjs/core`，将它的核心 API 导入改为 `dougong`。0.9.0 发布三个包；旧 Core 包保留此前已经发布的版本。

| 0.8.3 的导入位置 | 0.9.0 的导入位置 |
| --- | --- |
| `@dougongjs/core` 的契约、插件、Host 和资源协议 | `dougong` |
| 从 `dougong` 汇总导入的 Platform API | `@dougongjs/platform` |
| 从 `dougong` 汇总导入的响应式 API | `@dougongjs/reactive` |
| Core 的 `SnapshotPublisher`、`ReadonlyMapSnapshot`、`SerialQueue`、`normalizePlainRecord` | `dougong/advanced` |

使用交付层或响应式能力时，按需安装对应的 0.9.0 包并直接导入。主包不再汇总转发它们。

```ts
import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";
import { SnapshotPublisher } from "dougong/advanced";
import { createPlatform } from "@dougongjs/platform";
import { bridge, computed, observe, signal } from "@dougongjs/reactive";
```

发行物仍为 ESM，要求 Node.js `^24.22.0 || >=26.10.0`；浏览器最低版本为 Chrome/Edge 119、Firefox 124、Safari 17.4。TypeScript 使用 `ES2024`、`DOM` 和 `ESNext.Disposable` 库。原生浏览器模块还需要保留包内的 `runtime/` 并配置私有导入映射，见[快速开始](./getting-started.md#浏览器原生-esm)。

## 2. 将安装命令改为计划与执行

Installation 和 Group 现在是只读身份。把原先 Host 的直接安装、Installation 的更新和删除、Group 的删除以及 ChangeSet 的 commit 操作，改为暂存意图、生成 Plan、应用 Plan。

```ts
import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";

const GREETER = service<{ greet(name: string): string }>("application/greeter");
const greeter = definePlugin({
  name: "application.greeter",
  provides: { greeter: GREETER },
  setup() {
    return { greeter: { greet: (name) => `Hello, ${name}` } };
  },
});

const host = createHost({ name: "application" });
const change = host.change();
const installation = change.install(greeter, { id: "greeter" });
const plan = await host.plan(change);
await host.apply(plan);
await host.start();

const { value: message } = await host.use(GREETER, (value) => value.greet("Dougong"));
console.log(message);

const removal = host.change();
removal.remove(installation);
await host.apply(await host.plan(removal));
await host[asyncDisposeSymbol]();
```

安装必须提供在 Host 内唯一的稳定 `id`。分组通过 `change.group(id, parent)` 创建，通过 `change.removeGroup(group)` 移除。也可以在 `createHost` 的 `installations` 和 `groups` 中声明初始结构。查询已提交身份使用 `host.installation(id)` 和 `host.group(id)`。

删除对旧句柄 ready 方法的等待，直接等待 `plan`、`apply`、`start` 或 `stop`。规划时运行配置验证，apply 使用已经捕获的结果；规划不会执行 setup。运行中的整笔变更会在全部候选准备完成后共同发布。

Plan 绑定签发它的 Host 和状态修订，只能应用一次。不要持久化报告后尝试重放它。[`HOST_BUSY`](../reference/errors.md) 不消费 Plan；[`PLAN_STALE`](../reference/errors.md) 要求根据当前状态重新创建 ChangeSet 并规划。`host.plan(change, signal)` 可以取消尚未完成的规划；取消该请求不会撤销已经签发的 Plan。

`apply`、`start`、`stop` 成功时返回 `{ stateRevision, affectedInstallations }`；失败通过 Promise 拒绝报告。无需变更的操作不推进修订。诊断统一从 `host.diagnostics.get()` 读取，通过同一视图的 `subscribe()` 观察。

## 3. 更新插件上下文与配置

| 0.8.3 的写法 | 0.9.0 的写法 |
| --- | --- |
| context 上平铺的依赖别名 | `context.dependencies.alias` |
| context.meta | `context.metadata`，类型为 `InstanceMetadata` |
| context.log | `context.logger` |
| context.signal、context.spawn | `context.lifetime.signal`、`context.lifetime.spawn` |
| context.cleanup(cleanup) | `context.lifetime.defer(cleanup)` |
| context.lifetime(label) | `context.lifetime.child(label)` |
| context.on、context.emit | `context.events.on`、`context.events.emit` |
| context.contribute | `context.contributions.add` |
| Plugin、安装选项、更新和 Artifact 的 config 字段 | `configuration` |
| ConfigValidationError、CONFIG_INVALID | `ConfigurationValidationError`、[`CONFIGURATION_INVALID`](../reference/errors.md) |

依赖声明仍叫 `requires`，它的运行时解析结果位于 `dependencies`。配置仍通过 setup 的第二个参数传入。

资源操作属于 `context.lifetime`。标准资源交给 `use(resource)`，异步获取使用 `acquire(factory)`，释放函数使用 `defer(cleanup)`。`acquire` 返回冻结的 `{ resource }` 回执，需解构后使用资源。阻塞工作先用 `interrupt(interruptWork)` 中断，再等待任务和最终释放。

根 `LifetimeContext` 只授予登记工作和资源的能力；整个 Instance 由 Engine 停止。需要提前释放时创建 `ChildLifetime`，通过其标准异步释放协议关闭子树。事件与贡献默认属于根；归属子树时传入 `{ lifetime: child }`。

配置输入和 schema 输出必须是有限数字、字符串、布尔值、null、稠密数组或普通数据记录。把连接、函数、Promise、类实例和 getter 移出配置，改由声明的服务依赖或 Lifetime 获取。框架捕获并冻结配置；回滚复用已经验证的结果，不重新验证旧配置。

如果使用过早期 0.9 开发快照，还需将 deps 改为 dependencies、shutdownTimeoutMs 改为 `shutdownTimeoutMilliseconds`、captureConfig 改为 `captureConfiguration`、ConfigValue 改为 `ConfigurationValue`、PluginConfigDescriptor 改为 `PluginConfigurationDescriptor`；用 `host.diagnostics.get()` 替换旧 inspect 方法，并删除对成功结果中 outcome 字段的判断。

## 4. 借用服务与可执行贡献

把旧 Host 的 get 调用改为 `host.use(token, callback)`，在回调中完成本次使用。回调返回 Promise 时，借用持续到它完成；不要把服务引用保存到全局或返回给长寿命调用方。

贡献快照从包含值的 Map 改为冻结的有序 ID 数组。展示字段和执行处理函数都通过借用读取：

```ts
const commands = host.contributions(COMMANDS);
for (const id of commands.get()) {
  const { value: title } = await commands.use(id, (command) => command.title);
  console.log(title);
}
```

移除、更新或停机会检查受影响代次的借用。异步事件监听调用也借用其所有者，emit 等待全部监听结果；脱离广播继续运行的工作应显式使用 `lifetime.spawn`。候选 setup 不能发出公开事件。

订阅、贡献和资源句柄统一使用 `Symbol.dispose` 或 `Symbol.asyncDispose`；删除旧的命名式 dispose 调用。自定义 Readable 的取消订阅必须同步完成。跨 bundle 或跨模块副本的响应式源使用 `bridge(owner, source)` 显式接入本地 computed 图。

## 5. 重建 Platform 的交付流程

用稳定 `id` 和完整 `host` 创建 Platform；原来的 installer 选项由 `host` 和可选的已提交 `group` 取代。先把带有显式 `revision` 的 Artifact 加入 Catalog，再选择并激活。

```ts
import { createPlatform, MemoryLoader } from "@dougongjs/platform";

const deliveryHost = createHost();
await deliveryHost.start();
const platform = createPlatform({
  id: "application-plugins",
  host: deliveryHost,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["greeter-module", { default: greeter }]])),
});
const artifact = platform.catalog.add({
  revision: "greeter-content-1",
  manifest: { name: greeter.name, version: "1.0.0" },
  reference: "greeter-module",
});
const registration = await platform.select(artifact);
await platform.activate([registration]);
await deliveryHost.use(GREETER, (value) => value.greet("Dougong"));
await platform[asyncDisposeSymbol]();
await deliveryHost[asyncDisposeSymbol]();
```

示例沿用上文的主包导入、插件和服务契约声明。用新 Artifact 加 select 表达更新，用 `platform.activate(registrations, { remove })` 表达同次增、改、删，用 `platform.remove(...registrations)` 表达独立移除。删除旧 Registration 的 ready、activate、update、remove 调用和旧 Platform ChangeSet；Registration 现在是只读的选择身份。

删除可执行 placeholder。懒激活前根据 Manifest 展示发现信息，激活后借用真实能力。`selectedArtifact` 表示选择意图，`activeOrigin` 表示 Core 实际提交的来源，两者可以暂时不同。

自定义 Loader 实现 `load(reference, signal)`；Authorizer 接收 `{ artifact, operation }` 和取消信号，operation 区分 load 与 activate。激活授权还覆盖计划会重启的本 Platform 已提交 Artifact。直接捕获的 `PermissionDeniedError` 保留类型化属性；诊断中的权限数据改从 `error.snapshot.fields` 下的 manifestName 和 denied 读取。

## 处理失败与完成迁移

退出失败或超时会保留真实资源义务并隔离整个 Host。`quarantined` 是终止状态；重放 start、stop、apply 或创建新 Host 都不能证明旧资源已释放。迟到完成仅更新诊断。应用应按[隔离后的处置流程](./transactions.md#quarantine) 停止分派、保留诊断并处理旧执行边界。

完成升级后，验证安装、更新、移除、借用中的忙碌拒绝、失败恢复和退出路径。回滚重建旧声明对应的新 Instance，不会恢复旧对象或撤销文件、网络等外部副作用。完整公开协议见 [Core API](../reference/core-api.md) 和 [Platform 规范](../reference/platform.md)。

## 成功结果回执

`Task.result`、`host.use`、`ContributionView.use` 和 `SerialQueue.run` 的成功结果统一为冻结的 `{ value }` 回执（`ResolvedValue<T>`）。将原来的 `const result = await operation` 改为 `const { value: result } = await operation`；只等待完成、不读取结果的调用无需解构。`acquire` 继续使用 `{ resource }`。错误仍通过 Promise 拒绝传播。跨 realm Promise 必须保留正常的公开 `then`；完整的协议范围见[生命周期与资源](./lifetime.md)。
