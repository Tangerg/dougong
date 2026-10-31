import { captureConfig, type ConfigValue } from "dougong";
import { normalizePlainRecord } from "dougong/advanced";
import { satisfies } from "semver";
import { PlatformError } from "../errors.js";
import { defineManifest, type Manifest, type ManifestInput } from "./manifest.js";

export interface ArtifactInput<Reference> {
  readonly revision: string;
  readonly manifest: Manifest | ManifestInput;
  readonly reference: Reference;
  readonly config?: unknown;
}

export interface ArtifactDescriptor {
  readonly revision: string;
  readonly manifest: Manifest;
}

export interface Artifact<Reference> extends ArtifactDescriptor {
  readonly reference: Reference;
  readonly config: ConfigValue | undefined;
}

export interface ArtifactOrigin extends Readonly<Record<string, ConfigValue>> {
  readonly kind: "artifact";
  readonly platformId: string;
  readonly revision: string;
  readonly manifest: Manifest & Readonly<Record<string, ConfigValue>>;
}

const descriptors = new WeakMap<ArtifactDescriptor, ArtifactDescriptor>();

export function describeArtifact(artifact: ArtifactDescriptor): ArtifactDescriptor {
  const existing = descriptors.get(artifact);
  if (existing) return existing;
  const descriptor = Object.freeze({ revision: artifact.revision, manifest: artifact.manifest });
  descriptors.set(artifact, descriptor);
  return descriptor;
}

const originProjections = new WeakMap<object, ArtifactOrigin>();

const artifactFields = new Set(["revision", "manifest", "reference", "config"]);

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
  if (!satisfies(apiVersion, manifest.apiVersion)) {
    throw new PlatformError(
      "API_INCOMPATIBLE",
      `Artifact '${manifest.name}' requires API ${manifest.apiVersion}, Platform provides ${apiVersion}`,
    );
  }
  return Object.freeze({
    revision,
    manifest,
    reference: declaration.reference,
    config: captureConfig(declaration.config),
  });
}

export function artifactOrigin(platformId: string, artifact: ArtifactDescriptor): ArtifactOrigin {
  return captureConfig({
    kind: "artifact",
    platformId,
    revision: artifact.revision,
    manifest: artifact.manifest,
  }) as ArtifactOrigin;
}

export function readArtifactOrigin(
  value: Readonly<Record<string, ConfigValue>> | undefined,
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
    }) as ArtifactOrigin;
    originProjections.set(value, origin);
    return origin;
  } catch {
    return undefined;
  }
}
