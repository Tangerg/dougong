export {
  event,
  extensionPoint,
  optional,
  service,
  type ContractKind,
  type ContractValue,
  type Event,
  type ExtensionPoint,
  type OptionalService,
  type Requirement,
  type Service,
} from "./contracts";

export {
  createHost,
  type Host,
  type HostSnapshot,
  type HostStatus,
  type HostOptions,
  type GroupSnapshot,
  type ChangeSet,
  type Installer,
  type Group,
  type Installation,
  type InstallationSnapshot,
  type InstallationUpdate,
  type LifecycleStatus,
} from "./host";

export {
  definePlugin,
  type Awaitable,
  type PluginContext,
  type Plugin,
  type ProvidedServices,
  type Provisions,
  type Requirements,
  type ResolvedRequirement,
  type ResolvedRequirements,
} from "./plugin";

export {
  isLogger,
  type BackgroundTask,
  type Cleanup,
  type LifetimeContext,
  type LifetimeOperations,
  type LifetimePhase,
  type LifetimeSnapshot,
  type Logger,
  type InstanceMeta,
  type Task,
} from "./lifetime";

export type { Contribution, ContributionView } from "./contribution-store";
export type { EventListener } from "./event-hub";
export { ConfigValidationError, DougongError, isCancellationReason } from "./errors";
export type { AsyncDisposable, Disposable } from "./resource";
export { assertPlainRecord } from "./record";
export { ReadonlyMapSnapshot } from "./readonly-map";
export { SerialQueue } from "./serial-queue";
export { SnapshotPublisher, type SnapshotView } from "./snapshot-view";
