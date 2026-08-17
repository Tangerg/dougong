import type { AnyPlugin, AsyncDisposable, Logger, Installer, SnapshotView } from "@dougongjs/core";
import type { RegistrationStatus, PlatformSnapshot, PlatformStatus } from "./diagnostics";
import type { Loader } from "./loader";
import type { Manifest, ManifestInput } from "./manifest";
import type { Authorizer } from "./permissions";

export interface Artifact<Reference> {
  readonly manifest: Manifest | ManifestInput;
  readonly reference: Reference;
  /** Opaque input validated by the selected Plugin at the Core boundary. */
  readonly config?: unknown;
  /** Plugin supplied by application code until the external module is activated. */
  readonly placeholder?: AnyPlugin;
}

export interface Registration<Reference> {
  readonly manifest: Manifest;
  readonly status: RegistrationStatus;
  ready(): Promise<void>;
  activate(): Promise<void>;
  readonly update: (artifact: Artifact<Reference>) => Promise<void>;
  remove(): Promise<void>;
}

export interface PlatformChangeSet<Reference> {
  readonly register: (artifact: Artifact<Reference>) => Registration<Reference>;
  readonly update: (registration: Registration<Reference>, artifact: Artifact<Reference>) => void;
  readonly remove: (registration: Registration<Reference>) => void;
  commit(): Promise<void>;
}

export interface Platform<Reference> extends AsyncDisposable {
  readonly apiVersion: string;
  readonly status: PlatformStatus;
  readonly diagnostics: SnapshotView<PlatformSnapshot>;
  readonly register: (artifact: Artifact<Reference>) => Promise<Registration<Reference>>;
  change(): PlatformChangeSet<Reference>;
  trigger(event: string): Promise<void>;
}

export interface PlatformOptions<Reference> {
  readonly installer: Pick<Installer, "change">;
  readonly apiVersion: string;
  readonly loader: Loader<Reference>;
  readonly authorizer?: Authorizer;
  readonly logger?: Logger;
}

export interface NormalizedArtifact<Reference> {
  readonly manifest: Manifest;
  readonly reference: Reference;
  readonly config: unknown;
  readonly placeholder?: AnyPlugin;
}
