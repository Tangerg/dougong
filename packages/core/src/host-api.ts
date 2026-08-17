import type { HostSnapshot, HostStatus } from "./diagnostics";
import type { Logger } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import type { AnyPlugin, Plugin, Provisions, Requirements } from "./plugin";
import type { ExtensionPoint, OptionalService, Service } from "./contracts";
import type { ContributionView } from "./contribution-store";
import type { SnapshotView } from "./snapshot-view";

declare const installationBrand: unique symbol;

type DeclaredInstallationUpdate<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> =
  | {
      readonly plugin: Plugin<Config, Requires, Provides, ConfigInput>;
      readonly config?: ConfigInput;
    }
  | {
      readonly plugin?: never;
      readonly config: ConfigInput;
    };

type AnyPluginInstallationUpdate =
  | { readonly plugin: AnyPlugin; readonly config?: unknown }
  | { readonly plugin?: never; readonly config: unknown };

export type InstallationUpdate<Declaration extends AnyPlugin = AnyPlugin> =
  Declaration extends Plugin<infer Config, infer Requires, infer Provides, infer ConfigInput>
    ? DeclaredInstallationUpdate<Config, Requires, Provides, ConfigInput>
    : AnyPluginInstallationUpdate;

export type PluginConfigArguments<Declaration extends AnyPlugin> =
  Declaration extends Plugin<infer _Config, infer _Requires, infer _Provides, infer ConfigInput>
    ? [ConfigInput] extends [void]
      ? [config?: ConfigInput]
      : [config: ConfigInput]
    : [config?: unknown];

/**
 * One installed Plugin, as a stable identity. The declaration behind it may be
 * replaced; this identity and its position in the ownership tree may not.
 *
 * Installation and Group state their own capabilities instead of sharing a
 * framework-wide lifecycle interface. Code that wants to treat them uniformly
 * declares the minimum it needs on the consuming side:
 *
 * ```ts
 * interface Removable {
 *   ready(): Promise<void>
 *   remove(): Promise<void>
 * }
 * ```
 */
export interface Installation<Declaration extends AnyPlugin = AnyPlugin> {
  readonly [installationBrand]: (declaration: Declaration) => Declaration;
  readonly id: string;
  readonly groupId: string;
  readonly status: LifecycleStatus;
  ready(): Promise<void>;
  readonly update: (update: InstallationUpdate<Declaration>) => Promise<void>;
  remove(): Promise<void>;
}

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
  readonly onError?: (error: unknown) => void;
}

/** Capability to install into an ownership position without controlling Host execution. */
export interface Installer {
  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration>;
  group(name: string, configure: (group: Group) => void): Group;
  change(): ChangeSet;
}

/** Installation ownership only: never a capability scope or a permission boundary. */
export interface Group extends Installer {
  readonly id: string;
  readonly name: string;
  readonly status: LifecycleStatus;
  ready(): Promise<void>;
  remove(): Promise<void>;
}

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
