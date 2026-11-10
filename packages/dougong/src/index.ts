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
export type { ResolvedValue } from "./internal/async-result.js";
export type {
  ChangeSet,
  Group,
  Installation,
  InstallationOptions,
  InstallationArguments,
  InstallationUpdate,
  InstallationOrigin,
  InitialInstallation,
  InstallationState,
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
  type InstanceMetadata,
} from "./composition/plugin.js";
export { captureConfiguration, type ConfigurationValue } from "./composition/configuration.js";
export {
  describePlugin,
  type PluginDescriptor,
  type PluginConfigurationDescriptor,
  type PluginDescriptionOptions,
} from "./composition/plugin-description.js";
export type {
  Plan,
  PlanReport,
  ImpactReason,
  PlanOperation,
  DeclarationSnapshot,
} from "./composition/plan.js";
export type { BindingReport } from "./composition/installation-graph.js";
export type {
  HostSnapshot,
  HostStatus,
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
export type { Contribution } from "./contributions/contribution-store.js";
export type { ContributionView } from "./contributions/contribution-view.js";
export type { ContributionOperations } from "./contributions/contribution-registry.js";
export type { EventListener, EventOperations, EventArguments } from "./events/event-hub.js";
export { isLogger, type Logger } from "./contracts/logging.js";
export {
  DougongError,
  ConfigurationValidationError,
  isError,
  isCancellationReason,
  type ErrorDetails,
} from "./contracts/errors.js";
export { RecordedFailure, type ErrorSnapshot } from "./contracts/recorded-failure.js";
export {
  disposeSymbol,
  asyncDisposeSymbol,
  createResourceAuthority,
  type Disposable,
  type AsyncDisposable,
  type Resource,
  type ResourceAuthority,
  type Awaitable,
} from "./contracts/resource.js";
