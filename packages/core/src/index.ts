export {
  event,
  extension,
  optional,
  service,
  type ContractKind,
  type ContractValue,
  type Event,
  type Extension,
  type OptionalService,
  type Requirement,
  type Service,
} from "./contracts";

export {
  createApp,
  type Application,
  type ApplicationStatus,
  type CreateAppOptions,
  type PluginHandle,
  type PluginStatus,
  type PluginUpdate,
} from "./application";

export {
  definePlugin,
  type Awaitable,
  type PluginContext,
  type PluginDefinition,
  type ProvidedServices,
  type Provisions,
  type Requirements,
  type ResolvedRequirement,
  type ResolvedRequirements,
} from "./plugin";

export {
  type BackgroundTask,
  type Cleanup,
  type LifetimeContext,
  type LifetimeOperations,
  type Logger,
  type Observer,
  type PluginMeta,
  type Task,
} from "./lifetime";

export type { Contribution, ExtensionView } from "./extension-store";
export type { EventListener } from "./event-hub";
export { ConfigValidationError, DougongError } from "./errors";
export type { Disposable, Readable, ReadonlySignal } from "@dougong/reactive";
