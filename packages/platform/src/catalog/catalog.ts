import { ReadonlyMapSnapshot } from "dougong/advanced";
import { captureArtifact, type Artifact, type ArtifactInput } from "../artifacts/artifact.js";
import { PlatformError } from "../errors.js";

export interface Catalog<Reference> {
  readonly add: (input: ArtifactInput<Reference>) => Artifact<Reference>;
  get(name: string, revision: string): Artifact<Reference> | undefined;
  list(): ReadonlyMap<string, ReadonlyMap<string, Artifact<Reference>>>;
  remove(artifact: Artifact<Reference>): void;
}

export class ArtifactCatalog<Reference> implements Catalog<Reference> {
  readonly #apiVersion: string;
  readonly #artifacts = new Map<string, Map<string, Artifact<Reference>>>();
  readonly #revisions = new Map<string, Set<string>>();
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
    if (this.#revisions.get(name)?.has(artifact.revision)) {
      throw new PlatformError(
        "ARTIFACT_DUPLICATE",
        `Artifact '${name}' revision '${artifact.revision}' already exists`,
      );
    }
    const artifacts = this.#artifacts.get(name) ?? new Map<string, Artifact<Reference>>();
    artifacts.set(artifact.revision, artifact);
    this.#artifacts.set(name, artifacts);
    const revisions = this.#revisions.get(name) ?? new Set<string>();
    revisions.add(artifact.revision);
    this.#revisions.set(name, revisions);
    this.#owned.add(artifact);
    return artifact;
  }

  get(name: string, revision: string) {
    return this.#artifacts.get(name)?.get(revision);
  }

  list(): ReadonlyMap<string, ReadonlyMap<string, Artifact<Reference>>> {
    return new ReadonlyMapSnapshot(
      [...this.#artifacts].map(([name, artifacts]) => [name, new ReadonlyMapSnapshot(artifacts)]),
    );
  }

  remove(artifact: Artifact<Reference>) {
    this.assertAvailable(artifact);
    const revisions = this.#artifacts.get(artifact.manifest.name)!;
    revisions.delete(artifact.revision);
    if (!revisions.size) this.#artifacts.delete(artifact.manifest.name);
  }

  assertAvailable(artifact: Artifact<Reference>) {
    this.#assertActive();
    if (
      !this.#owned.has(artifact) ||
      this.get(artifact.manifest.name, artifact.revision) !== artifact
    ) {
      throw new PlatformError("ARTIFACT_UNAVAILABLE", "Artifact is not available in this Catalog");
    }
  }

  close() {
    this.#active = false;
    this.#artifacts.clear();
    this.#revisions.clear();
  }

  #assertActive() {
    if (!this.#active) throw new PlatformError("PLATFORM_UNAVAILABLE", "Catalog is closed");
  }
}
