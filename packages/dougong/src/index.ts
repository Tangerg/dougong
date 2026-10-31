export {
  service,
  extensionPoint,
  event,
  optional,
  type ContractKind,
  type ContractValue,
  type Service,
  type ExtensionPoint,
  type Event,
  type OptionalService,
  type Requirement,
} from "./contracts/contracts.js";
export { createHost } from "./execution/host.js";
export type { Host, HostOptions, ApplyResult } from "./execution/host-api.js";
export type { HostStatus, InstallationState } from "./contracts/status.js";
export type {
  ChangeSet,
  Group,
  Installation,
  InstallationOptions,
  InstallationUpdate,
  InstallationOrigin,
  InitialInstallation,
} from "./composition/declarations.js";
export {
  definePlugin,
  type Plugin,
  type AnyPlugin,
  type PluginContext,
  type Requirements,
  type Provisions,
  type ResolvedRequirement,
  type ResolvedRequirements,
  type ProvidedServices,
  type InstanceMeta,
} from "./composition/plugin.js";
export { captureConfig, type ConfigValue } from "./composition/configuration.js";
export {
  describePlugin,
  type PluginDescriptor,
  type PluginConfigDescriptor,
  type PluginDescriptionOptions,
} from "./composition/plugin-description.js";
export type {
  Plan,
  PlanReport,
  BindingReport,
  ImpactReason,
  PlanOperation,
  DeclarationSnapshot,
} from "./composition/plan.js";
export type {
  HostSnapshot,
  InstallationSnapshot,
  GroupSnapshot,
} from "./inspection/diagnostics.js";
export type { SnapshotView } from "./observation/snapshot-view.js";
export type {
  LifetimeContext,
  ChildLifetime,
  LifetimeOwnership,
  Task,
  Cleanup,
  BackgroundTask,
  LifetimePhase,
  LifetimeSnapshot,
  UnresolvedObligation,
} from "./lifetime/lifetime.js";
export type {
  Contribution,
  ContributionView,
  ContributionOperations,
} from "./contributions/contribution-store.js";
export type { EventListener, EventOperations, EventArguments } from "./events/event-hub.js";
export { isLogger, type Logger } from "./contracts/logging.js";
export {
  DougongError,
  ConfigValidationError,
  RecordedFailure,
  isError,
  isCancellationReason,
  type ErrorSnapshot,
  type ErrorDetails,
} from "./contracts/errors.js";
export {
  disposeSymbol,
  asyncDisposeSymbol,
  type Disposable,
  type AsyncDisposable,
  type Resource,
  type Awaitable,
} from "./contracts/resource.js";
