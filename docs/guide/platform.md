# 外部插件交付

Platform 组合 Dougong 的公开 API，负责发行事实、选择意图、加载、准入与激活。Catalog 拥有不可变 Artifact；Registration 拥有选择。实际执行来源直接读取 Core Installation 的 `origin`。

```ts
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";

const platform = createPlatform({
  id: "editor-plugins",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["formatter-module", { default: formatter }]])),
  authorizer: new PermissionSet(["workspace:read"]),
});
const artifact = platform.catalog.add({
  revision: "formatter-content-1",
  manifest: {
    name: formatter.name,
    version: "1.0.0",
    permissions: ["workspace:read"],
    activation: ["command:format"],
  },
  reference: "formatter-module",
});
const registration = await platform.select(artifact);
const preview = platform.preview([registration]);
await platform.trigger("command:format");
await platform[Symbol.asyncDispose]();
```

预览只检查声明数据，列出明确延后的准入、模块验证、配置验证和 Core 绑定检查。查看 Catalog、选择或预览不会执行插件代码。懒激活之前没有可执行 placeholder；应用根据 Manifest 展示可发现信息，触发激活后才借用真实能力。

授权有两个精确边界：模块求值之前的 `load`，以及 Core 规划完成、向 Core 提交计划之前的 `activate`。自定义 `Authorizer` 接收 Artifact 身份、操作与 AbortSignal。等待加载授权时，如果目标 Group 被删除或 Host 进入隔离，Platform 不再执行模块。取消激活会结束对加载器、配置验证器或授权器的等待，即使它们不配合取消。一旦进入 `host.apply`，调用方收到的就是 Core 的实际结果。

更新先添加新 Artifact，再 select；选择意图可以领先于实际执行。即便 Installation 和 revision 相同，原生 Core 变更也可能改写已提交的 Manifest。下次激活会先纠正不一致，而不会把尚未安装的版本当作已满足依赖。通过 `selectedArtifact` 与 `activeOrigin` 显式表达这种差异，不复制“已激活 Manifest”。

```ts
const selected = await platform.select(nextArtifact);
await platform.activate([selected, another], { remove: [obsolete] });
```

应用可以通过 `platform.registrations()` 核对当前选择，不需要自行维护另一份“名称 → 句柄”注册表。诊断用于渲染状态，当前句柄列表用于明确命令目标。

同次增、改、删编译成一笔 Core Plan。`remove` 也复用该执行路径。Catalog 删除只忘记发现记录，不隐式删除已经选择或运行的能力。

独立 Host 是装配边界；同一 realm 的 ImportLoader 不是权限沙箱。需要不可信代码执行时，另外设计进程、Worker 或 WASM 执行器及其权限、通信和终止协议。

## 从动作声明派生激活

命令的 ID 与标题归应用的 `ActionDeclaration` 数据所有。示例 08 和 10 从同一声明生成可发现元数据、Contribution 的身份和 `actions.map(actionActivation)` 激活列表；实际 handler 只在 setup 中组合进入贡献。触发器也调用 `actionActivation(action)`，不再维护手写的重复事件字符串。

固定的 startup 策略、权限请求和版本范围属于独立交付事实，仍需显式声明。不要从 TypeScript 接口猜测未知运行协议。
