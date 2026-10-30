import type { ErrorSnapshot } from "../contracts/errors.js";
import type { InstallationOrigin } from "../composition/declarations.js";
import type { InstallationState, HostStatus } from "../contracts/status.js";
import type { LifetimeSnapshot } from "../lifetime/lifetime-diagnostics.js";
import type { BindingReport } from "../composition/plan.js";

export interface InstallationSnapshot {
  readonly id: string;
  readonly groupId: string | undefined;
  readonly pluginName: string;
  readonly status: InstallationState;
  readonly origin: InstallationOrigin | undefined;
  readonly generation: number | undefined;
  readonly requires: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly lifetime: LifetimeSnapshot | undefined;
}

export interface GroupSnapshot {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly installations: ReadonlyArray<string>;
}

export interface HostSnapshot {
  readonly name: string;
  readonly status: HostStatus;
  readonly stateRevision: number;
  readonly installations: ReadonlyArray<InstallationSnapshot>;
  readonly groups: ReadonlyArray<GroupSnapshot>;
  readonly bindings: ReadonlyArray<BindingReport>;
  readonly unresolved: ReadonlyArray<{
    readonly installation: string;
    readonly generation: number;
    readonly lifetime: LifetimeSnapshot;
  }>;
  readonly error: ErrorSnapshot | undefined;
}
