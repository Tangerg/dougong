import type {
  ChangeSet,
  Group,
  Installation,
  InitialInstallation,
} from "../composition/declarations.js";
import type { Logger } from "../contracts/logging.js";
import type { Service, OptionalService, ExtensionPoint } from "../contracts/contracts.js";
import type { ContributionView } from "../contributions/contribution-view.js";
import type { SnapshotView } from "../observation/snapshot-view.js";
import type { HostSnapshot, HostStatus } from "../inspection/diagnostics.js";
import type { Awaitable } from "../contracts/resource.js";
import type { Plan } from "../composition/plan.js";
import type { BindingReport } from "../composition/installation-graph.js";
import type { AnyPlugin } from "../composition/plugin.js";
import type { ResolvedValue } from "../internal/async-result.js";

export interface HostOptions<
  Declarations extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>,
> {
  readonly name?: string;
  // Infer Plugins before checking their configuration so union-typed arrays retain each pairing.
  readonly installations?: {
    readonly [Index in keyof Declarations]: {
      readonly plugin: Declarations[Index];
    } & NoInfer<InitialInstallation<Declarations[Index]>>;
  };
  readonly groups?: ReadonlyArray<{ readonly id: string; readonly parentId?: string }>;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => Awaitable<void>;
  readonly shutdownTimeoutMilliseconds?: number;
}

export interface ApplyResult {
  readonly stateRevision: number;
  readonly affectedInstallations: ReadonlyArray<string>;
}

export interface Host {
  readonly name: string;
  readonly status: HostStatus;
  readonly stateRevision: number;
  readonly diagnostics: SnapshotView<HostSnapshot>;
  change(): ChangeSet;
  plan(change: ChangeSet, signal?: AbortSignal): Promise<Plan>;
  apply(plan: Plan): Promise<ApplyResult>;
  start(): Promise<ApplyResult>;
  stop(): Promise<ApplyResult>;
  use<T, Result>(
    service: Service<T>,
    callback: (value: T) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>>;
  use<T, Result>(
    service: OptionalService<T>,
    callback: (value: T | undefined) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>>;
  contributions<T>(point: ExtensionPoint<T>): ContributionView<T>;
  installation(id: string): Installation | undefined;
  group(id: string): Group | undefined;
  explain(installationId: string): ReadonlyArray<BindingReport>;
  [Symbol.asyncDispose](): Promise<void>;
}
