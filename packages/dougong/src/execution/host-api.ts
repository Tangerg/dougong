import type {
  ChangeSet,
  Group,
  Installation,
  InitialInstallation,
} from "../composition/declarations.js";
import type { HostStatus } from "../contracts/status.js";
import type { Logger } from "../contracts/logging.js";
import type { Service, OptionalService, ExtensionPoint } from "../contracts/contracts.js";
import type { ContributionView } from "../contributions/contribution-store.js";
import type { SnapshotView } from "../observation/snapshot-view.js";
import type { HostSnapshot } from "../inspection/diagnostics.js";
import type { Awaitable } from "../contracts/resource.js";
import type { Plan, BindingReport } from "../composition/plan.js";

export interface HostOptions {
  readonly name?: string;
  readonly installations?: ReadonlyArray<InitialInstallation>;
  readonly groups?: ReadonlyArray<{ readonly id: string; readonly parentId?: string }>;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => Awaitable<void>;
  readonly shutdownTimeoutMs?: number;
}

export interface ApplyResult {
  readonly outcome: "committed";
  readonly stateRevision: number;
  readonly affectedInstallations: ReadonlyArray<string>;
}

export interface Host {
  readonly name: string;
  readonly status: HostStatus;
  readonly stateRevision: number;
  readonly diagnostics: SnapshotView<HostSnapshot>;
  change(): ChangeSet;
  plan(change: ChangeSet): Promise<Plan>;
  apply(plan: Plan): Promise<ApplyResult>;
  start(): Promise<ApplyResult>;
  stop(): Promise<ApplyResult>;
  use<T, R>(service: Service<T>, callback: (value: T) => Awaitable<R>): Promise<R>;
  use<T, R>(
    service: OptionalService<T>,
    callback: (value: T | undefined) => Awaitable<R>,
  ): Promise<R>;
  contributions<T>(point: ExtensionPoint<T>): ContributionView<T>;
  installation(id: string): Installation | undefined;
  group(id: string): Group | undefined;
  inspect(): HostSnapshot;
  explain(installationId: string): ReadonlyArray<BindingReport>;
  [Symbol.asyncDispose](): Promise<void>;
}
