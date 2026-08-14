import type {
  Logger,
  PluginContainer,
  PluginDefinition,
  Provisions,
  Requirements,
  SnapshotView,
} from "@dougong/core";
import type {
  ManagedPluginStatus,
  PluginPlatformSnapshot,
  PluginPlatformStatus,
} from "./diagnostics";
import type { PluginLoader } from "./loader";
import type { PluginManifest, PluginManifestInput } from "./manifest";
import type { PermissionAuthorizer } from "./permissions";

interface PluginArtifactDeclaration<
  Reference,
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> {
  readonly manifest: PluginManifest | PluginManifestInput;
  readonly reference: Reference;
  /** Host-authored definition exposed until the external module is activated. */
  readonly placeholder?: PluginDefinition<Config, Requires, Provides, ConfigInput>;
}

export type PluginArtifact<
  Reference,
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
> = PluginArtifactDeclaration<Reference, Config, Requires, Provides, ConfigInput> &
  ([ConfigInput] extends [void]
    ? { readonly config?: ConfigInput }
    : { readonly config: ConfigInput });

export interface ManagedPlugin<Reference> {
  readonly name: string;
  readonly manifest: PluginManifest;
  readonly status: ManagedPluginStatus;
  ready(): Promise<void>;
  activate(): Promise<void>;
  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): Promise<void>;
  remove(): Promise<void>;
}

export interface PlatformChangeSet<Reference> {
  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): ManagedPlugin<Reference>;
  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    plugin: ManagedPlugin<Reference>,
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): this;
  remove(plugin: ManagedPlugin<Reference>): this;
  commit(): Promise<void>;
}

export interface PluginPlatform<Reference> {
  readonly apiVersion: string;
  readonly status: PluginPlatformStatus;
  readonly diagnostics: SnapshotView<PluginPlatformSnapshot>;
  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): Promise<ManagedPlugin<Reference>>;
  change(): PlatformChangeSet<Reference>;
  trigger(event: string): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CreatePlatformOptions<Reference> {
  readonly container: PluginContainer;
  readonly apiVersion: string;
  readonly loader: PluginLoader<Reference>;
  readonly permissions?: PermissionAuthorizer;
  readonly logger?: Logger;
}

export type AnyDefinition = PluginDefinition<unknown, Requirements, Provisions, unknown>;

export interface NormalizedArtifact<Reference> {
  readonly manifest: PluginManifest;
  readonly reference: Reference;
  readonly config: unknown;
  readonly placeholder?: AnyDefinition;
}
