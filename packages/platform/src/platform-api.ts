import type { AnyPlugin, AsyncDisposable, Logger, Installer, SnapshotView } from "@dougongjs/core";
import type { RegistrationStatus, PlatformSnapshot, PlatformStatus } from "./diagnostics";
import type { Loader } from "./loader";
import type { Manifest, ManifestInput } from "./manifest";
import type { Authorizer } from "./permissions";

/**
 * One candidate for admission: what it claims to be, plus how to reach it.
 *
 * `Reference` is the Platform's one type parameter, and it stays generic all the
 * way down because Platform never interprets it — a URL, a bundle key, a
 * worker id, whatever the paired Loader understands. Deciding that here would
 * make module resolution Platform's business instead of the Loader's.
 */
export interface Artifact<Reference> {
  readonly manifest: Manifest | ManifestInput;
  readonly reference: Reference;
  /** Opaque input validated by the selected Plugin at the Core boundary. */
  readonly config?: unknown;
  /**
   * Plugin supplied by application code until the external module is activated.
   *
   * This is what makes lazy activation invisible to the rest of the graph: the
   * placeholder occupies the Installation from registration, and activation
   * replaces it in one atomic Core update. Consumers see a Service appear, never
   * an Installation come into existence.
   */
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
  /**
   * Where admitted code is installed. `Pick<Installer, "change">` rather than a
   * Host, so a Platform can be pointed at a Group — and cannot start, stop or
   * read from the Host it installs into.
   */
  readonly installer: Pick<Installer, "change">;
  /** The API version application code offers; each Manifest declares what it needs. */
  readonly apiVersion: string;
  readonly loader: Loader<Reference>;
  /**
   * Defaults to an empty `PermissionSet`, so with none given a Manifest that
   * asks for nothing is admitted and anything that asks is denied.
   */
  readonly authorizer?: Authorizer;
  readonly logger?: Logger;
}

export interface NormalizedArtifact<Reference> {
  readonly manifest: Manifest;
  readonly reference: Reference;
  readonly config: unknown;
  readonly placeholder?: AnyPlugin;
}
