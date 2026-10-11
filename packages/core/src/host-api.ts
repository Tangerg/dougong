import type { HostSnapshot, HostStatus, InstallationSnapshot } from "./diagnostics";
import type { Logger } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import type { AnyPlugin, Plugin } from "./plugin";
import type { ExtensionPoint, OptionalService, Service } from "./contracts";
import type { ContributionView } from "./contribution-store";
import type { SnapshotView } from "./snapshot-view";
import type { Awaitable } from "./resource";
import type { InstallationUpdate } from "./installation";
export type { InstallationUpdate } from "./installation";

declare const installationBrand: unique symbol;

export type PluginConfigArguments<Declaration extends AnyPlugin> =
  Declaration extends Plugin<infer _Config, infer _Requires, infer _Provides, infer ConfigInput>
    ? [ConfigInput] extends [void]
      ? [config?: ConfigInput]
      : [config: ConfigInput]
    : [config?: unknown];

export interface Installation<Declaration extends AnyPlugin = AnyPlugin> {
  readonly [installationBrand]: (declaration: Declaration) => Declaration;
  readonly id: string;
  readonly groupId: string;
  readonly status: LifecycleStatus;
  readonly diagnostics: SnapshotView<InstallationSnapshot>;
  ready(): Promise<void>;
  readonly update: (update: InstallationUpdate<Declaration>) => Promise<void>;
  remove(): Promise<void>;
}

// Only the final graph needs to resolve; validating each staged operation would reject valid atomic batches.
export interface ChangeSet extends Pick<Installer, "install"> {
  update<Declaration extends AnyPlugin>(
    installation: Installation<Declaration>,
    update: InstallationUpdate<Declaration>,
  ): void;
  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>): void;
  commit(): Promise<void>;
}

export interface HostOptions {
  readonly name?: string;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => Awaitable<void>;
}

export interface Installer {
  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration>;
  group(name: string, configure: (group: Group) => void): Group;
  change(): ChangeSet;
}

export interface Group extends Installer {
  readonly id: string;
  readonly name: string;
  readonly status: LifecycleStatus;
  ready(): Promise<void>;
  remove(): Promise<void>;
}

// Plugins receive declared dependencies through context so Host lookup cannot become a Service Locator.
export interface Host extends Installer {
  readonly name: string;
  readonly status: HostStatus;
  readonly diagnostics: SnapshotView<HostSnapshot>;
  get<T>(token: Service<T>): T;
  get<T>(token: OptionalService<T>): T | undefined;
  contributions<T>(token: ExtensionPoint<T>): ContributionView<T>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
