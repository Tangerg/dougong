import type { HostSnapshot, HostStatus } from "./diagnostics";
import type { GroupStatus } from "./group";
import type { Logger } from "./lifetime";
import type { InstallationStatus } from "./installation";
import type { Plugin, Provisions, Requirements } from "./plugin";
import type { Service } from "./contracts";
import type { SnapshotView } from "./snapshot-view";

export type InstallationUpdate<
  Config,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> =
  | {
      readonly plugin: Plugin<Config, Requires, Provides, ConfigInput>;
      readonly config?: ConfigInput;
    }
  | {
      readonly plugin?: never;
      readonly config: ConfigInput;
    };

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
export interface Installation<
  Config = unknown,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> {
  readonly id: string;
  readonly groupId: string;
  readonly status: InstallationStatus;
  ready(): Promise<void>;
  update(update: InstallationUpdate<Config, Requires, Provides, ConfigInput>): Promise<void>;
  remove(): Promise<void>;
}

export interface ChangeSet {
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput>;
  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    installation: Installation<Config, Requires, Provides, ConfigInput>,
    update: InstallationUpdate<Config, Requires, Provides, ConfigInput>,
  ): this;
  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    installation: Installation<Config, Requires, Provides, ConfigInput>,
  ): this;
  commit(): Promise<void>;
}

export interface HostOptions {
  readonly name?: string;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => void;
}

/** Minimal target for higher layers that compile work into one Core ChangeSet. */
export interface Installer {
  change(): ChangeSet;
}

/** Installation ownership only: never a capability scope or a permission boundary. */
export interface Group extends Installer {
  readonly id: string;
  readonly name: string;
  readonly status: GroupStatus;
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput>;
  group(name: string, configure: (group: Group) => void): Group;
  ready(): Promise<void>;
  remove(): Promise<void>;
}

export interface Host extends Installer {
  readonly name: string;
  readonly status: HostStatus;
  readonly diagnostics: SnapshotView<HostSnapshot>;
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput>;
  group(name: string, configure: (group: Group) => void): Group;
  get<T>(token: Service<T>): T;
  start(): Promise<void>;
  stop(): Promise<void>;
}
