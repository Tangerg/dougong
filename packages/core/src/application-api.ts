import type { ApplicationSnapshot, ApplicationStatus } from "./diagnostics";
import type { Logger } from "./lifetime";
import type { PluginStatus } from "./plugin-instance";
import type { PluginDefinition, Provisions, Requirements } from "./plugin";
import type { Service } from "./contracts";
import type { SnapshotView } from "./snapshot-view";

export type PluginUpdate<
  Config,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> =
  | {
      readonly plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>;
      readonly config?: ConfigInput;
    }
  | {
      readonly plugin?: never;
      readonly config: ConfigInput;
    };

export interface InstallHandle {
  readonly id: string;
  readonly status: PluginStatus;
  ready(): Promise<void>;
  remove(): Promise<void>;
}

export interface PluginHandle<
  Config = unknown,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> extends InstallHandle {
  readonly group: string;
  update(update: PluginUpdate<Config, Requires, Provides, ConfigInput>): Promise<void>;
}

export interface PluginChangeSet {
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput>;
  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
    update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
  ): this;
  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
  ): this;
  commit(): Promise<void>;
}

export interface CreateAppOptions {
  readonly name?: string;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => void;
}

export interface PluginContainer {
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput>;
  change(): PluginChangeSet;
  group(name: string, configure: (group: PluginGroup) => void): PluginGroup;
}

export interface PluginGroup extends PluginContainer, InstallHandle {
  readonly name: string;
}

export interface Application extends PluginContainer {
  readonly name: string;
  readonly status: ApplicationStatus;
  readonly diagnostics: SnapshotView<ApplicationSnapshot>;
  get<T>(token: Service<T>): T;
  start(): Promise<void>;
  stop(): Promise<void>;
}
