import type {
  Logger,
  Installer,
  Plugin,
  Provisions,
  Requirements,
  SnapshotView,
} from "@dougongjs/core";
import type { RegistrationStatus, PlatformSnapshot, PlatformStatus } from "./diagnostics";
import type { Loader } from "./loader";
import type { Manifest, ManifestInput } from "./manifest";
import type { Authorizer } from "./permissions";

interface ArtifactDeclaration<
  Reference,
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> {
  readonly manifest: Manifest | ManifestInput;
  readonly reference: Reference;
  /** Plugin supplied by application code until the external module is activated. */
  readonly placeholder?: Plugin<Config, Requires, Provides, ConfigInput>;
}

export type Artifact<
  Reference,
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
> = ArtifactDeclaration<Reference, Config, Requires, Provides, ConfigInput> &
  ([ConfigInput] extends [void]
    ? { readonly config?: ConfigInput }
    : { readonly config: ConfigInput });

export interface Registration<Reference> {
  readonly manifest: Manifest;
  readonly status: RegistrationStatus;
  ready(): Promise<void>;
  activate(): Promise<void>;
  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
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
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): Registration<Reference>;
  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    registration: Registration<Reference>,
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): this;
  remove(registration: Registration<Reference>): this;
  commit(): Promise<void>;
}

export interface Platform<Reference> {
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): Promise<Registration<Reference>>;
  change(): PlatformChangeSet<Reference>;
  trigger(event: string): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface PlatformOptions<Reference> {
  readonly installer: Installer;
  readonly apiVersion: string;
  readonly loader: Loader<Reference>;
  readonly authorizer?: Authorizer;
  readonly logger?: Logger;
}

export type ErasedPlugin = Plugin<unknown, Requirements, Provisions, unknown>;

export interface NormalizedArtifact<Reference> {
  readonly manifest: Manifest;
  readonly reference: Reference;
  readonly config: unknown;
  readonly placeholder?: ErasedPlugin;
}
