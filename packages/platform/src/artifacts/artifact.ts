import { captureConfiguration, type ConfigurationValue } from "dougong";
import { normalizePlainRecord, recordFields } from "dougong/advanced";
import { satisfies } from "semver";
import { PlatformError } from "../errors.js";
import { defineManifest, type Manifest, type ManifestInput } from "./manifest.js";

export interface ArtifactInput<Reference> {
  readonly revision: string;
  readonly manifest: ManifestInput;
  readonly reference: Reference;
  readonly configuration?: unknown;
}

export interface ArtifactDescriptor {
  readonly revision: string;
  readonly manifest: Manifest;
}

export interface Artifact<Reference> extends ArtifactDescriptor {
  readonly reference: Reference;
  readonly configuration: ConfigurationValue | undefined;
}

export interface ArtifactOrigin extends Readonly<Record<string, ConfigurationValue>> {
  readonly kind: "artifact";
  readonly platformId: string;
  readonly revision: string;
  readonly manifest: Manifest;
}

const descriptors = new WeakMap<ArtifactDescriptor, ArtifactDescriptor>();

export function describeArtifact(artifact: ArtifactDescriptor): ArtifactDescriptor {
  const existing = descriptors.get(artifact);
  if (existing) return existing;
  const descriptor = Object.freeze({ revision: artifact.revision, manifest: artifact.manifest });
  descriptors.set(artifact, descriptor);
  return descriptor;
}

const manifestKeys = new WeakMap<Manifest, string>();

function manifestKey(manifest: Manifest): string {
  const existing = manifestKeys.get(manifest);
  if (existing !== undefined) return existing;
  // Permissions and activation events express membership; dependency keys express named ranges.
  const key = JSON.stringify({
    ...manifest,
    permissions: [...manifest.permissions].sort(),
    activation: [...manifest.activation].sort(),
    dependencies: Object.keys(manifest.dependencies)
      .sort()
      .map((name) => [name, manifest.dependencies[name]]),
  });
  manifestKeys.set(manifest, key);
  return key;
}

export function matchesArtifact(origin: ArtifactOrigin | undefined, artifact: ArtifactDescriptor) {
  return (
    origin?.revision === artifact.revision &&
    manifestKey(origin.manifest) === manifestKey(artifact.manifest)
  );
}

const originProjections = new WeakMap<object, ArtifactOrigin>();

const artifactFields = recordFields<ArtifactInput<unknown>>()(
  "revision",
  "manifest",
  "reference",
  "configuration",
);

export function captureArtifact<Reference>(
  apiVersion: string,
  input: ArtifactInput<Reference>,
): Artifact<Reference> {
  const declaration = normalizePlainRecord(input, "Artifact declaration", {
    fields: artifactFields,
  });
  const revision = declaration.revision;
  if (typeof revision !== "string" || !revision || revision.trim() !== revision) {
    throw new TypeError("Artifact revision must be a non-empty trimmed string");
  }
  if (!Object.hasOwn(declaration, "reference")) {
    throw new TypeError("Artifact declaration must define reference");
  }
  const manifest = defineManifest(declaration.manifest);
  assertCompatibleManifest(apiVersion, manifest);
  return Object.freeze({
    revision,
    manifest,
    reference: declaration.reference,
    configuration: captureConfiguration(declaration.configuration),
  });
}

export function assertCompatibleManifest(apiVersion: string, manifest: Manifest) {
  if (!satisfies(apiVersion, manifest.apiVersion)) {
    throw new PlatformError(
      "API_INCOMPATIBLE",
      `Artifact '${manifest.name}' requires API ${manifest.apiVersion}, Platform provides ${apiVersion}`,
    );
  }
}

export function artifactOrigin(platformId: string, artifact: ArtifactDescriptor): ArtifactOrigin {
  return Object.freeze({
    kind: "artifact",
    platformId,
    revision: artifact.revision,
    manifest: artifact.manifest,
  });
}

export function readArtifactOrigin(
  value: Readonly<Record<string, ConfigurationValue>> | undefined,
  platformId: string,
  name: string,
): ArtifactOrigin | undefined {
  if (value?.kind !== "artifact" || value.platformId !== platformId) return undefined;
  if (
    typeof value.revision !== "string" ||
    !value.revision ||
    value.revision.trim() !== value.revision ||
    !value.manifest ||
    typeof value.manifest !== "object"
  ) {
    return undefined;
  }
  const existing = originProjections.get(value);
  if (existing) return existing.manifest.name === name ? existing : undefined;
  try {
    const manifest = defineManifest(value.manifest as unknown as ManifestInput);
    if (manifest.name !== name) return undefined;
    const origin = Object.freeze({
      kind: "artifact",
      platformId,
      revision: value.revision,
      manifest,
    });
    originProjections.set(value, origin);
    return origin;
  } catch {
    return undefined;
  }
}
