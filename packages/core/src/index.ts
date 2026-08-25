// The public surface of @dougongjs/core. Nothing here is re-exported with
// `export *`: the list is written out so adding a name is a deliberate act.
//
// `scripts/check-api-surface.mjs` reads the built `dist/index.d.ts` and compares
// it against an explicit allowlist, so an accidental export fails CI rather than
// quietly becoming API. That gate — not this file — is the authority on what is
// public.

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
  type AnyPlugin,
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
export { ConfigValidationError, DougongError, ErrorSummary, isCancellationReason } from "./errors";
export {
  asyncDisposeSymbol,
  disposeSymbol,
  type AsyncDisposable,
  type Disposable,
} from "./resource";
export { assertPlainRecord } from "./record";
export { ReadonlyMapSnapshot } from "./readonly-map";
export { SerialQueue } from "./serial-queue";
export { SnapshotPublisher, type SnapshotView } from "./snapshot-view";
