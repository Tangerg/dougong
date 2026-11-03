import { ReadonlyMapSnapshot } from "dougong/advanced";
import { captureArtifact, type Artifact, type ArtifactInput } from "../artifacts/artifact.js";
import {
  PlatformError,
  artifactDuplicateCode,
  artifactUnavailableCode,
  platformUnavailableCode,
} from "../errors.js";

export interface Catalog<Reference> {
  readonly add: (input: ArtifactInput<Reference>) => Artifact<Reference>;
  get(name: string, revision: string): Artifact<Reference> | undefined;
  list(): ReadonlyMap<string, ReadonlyMap<string, Artifact<Reference>>>;
  remove(artifact: Artifact<Reference>): void;
}

export class ArtifactCatalog<Reference> implements Catalog<Reference> {
  readonly #apiVersion: string;
  readonly #artifacts = new Map<string, Map<string, Artifact<Reference> | undefined>>();
  readonly #owned = new WeakSet<Artifact<Reference>>();
  #active = true;
  readonly facade: Catalog<Reference> = Object.freeze({
    add: (input: ArtifactInput<Reference>) => this.add(input),
    get: (name: string, revision: string) => this.get(name, revision),
    list: () => this.list(),
    remove: (artifact: Artifact<Reference>) => this.remove(artifact),
  });

  constructor(apiVersion: string) {
    this.#apiVersion = apiVersion;
    Object.freeze(this);
  }

  add(input: ArtifactInput<Reference>) {
    this.#assertActive();
    const artifact = captureArtifact(this.#apiVersion, input);
    const name = artifact.manifest.name;
    const artifacts =
      this.#artifacts.get(name) ?? new Map<string, Artifact<Reference> | undefined>();
    if (artifacts.has(artifact.revision)) {
      throw new PlatformError(
        artifactDuplicateCode,
        `Artifact '${name}' revision '${artifact.revision}' already exists`,
      );
    }
    artifacts.set(artifact.revision, artifact);
    this.#artifacts.set(name, artifacts);
    this.#owned.add(artifact);
    return artifact;
  }

  get(name: string, revision: string) {
    return this.#artifacts.get(name)?.get(revision);
  }

  list(): ReadonlyMap<string, ReadonlyMap<string, Artifact<Reference>>> {
    return new ReadonlyMapSnapshot(
      [...this.#artifacts].flatMap(([name, artifacts]) => {
        const available = [...artifacts].flatMap(([revision, artifact]) =>
          artifact ? [[revision, artifact] as const] : [],
        );
        return available.length ? [[name, new ReadonlyMapSnapshot(available)] as const] : [];
      }),
    );
  }

  remove(artifact: Artifact<Reference>) {
    this.assertAvailable(artifact);
    const revisions = this.#artifacts.get(artifact.manifest.name)!;
    // A removed revision stays reserved without retaining its module reference or configuration.
    revisions.set(artifact.revision, undefined);
  }

  assertAvailable(artifact: Artifact<Reference>) {
    this.#assertActive();
    if (
      !this.#owned.has(artifact) ||
      this.get(artifact.manifest.name, artifact.revision) !== artifact
    ) {
      throw new PlatformError(artifactUnavailableCode, "Artifact is not available in this Catalog");
    }
  }

  close() {
    this.#active = false;
    this.#artifacts.clear();
  }

  #assertActive() {
    if (!this.#active) throw new PlatformError(platformUnavailableCode, "Catalog is closed");
  }
}
