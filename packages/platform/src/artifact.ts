import {
  normalizePlainRecord,
  definePlugin,
  isCancellationReason,
  type AnyPlugin,
  type Plugin,
  type Provisions,
  type Requirements,
} from "@dougongjs/core";
import { satisfies } from "semver";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import { defineManifest, type Manifest } from "./manifest";
import type { Artifact, NormalizedArtifact } from "./platform-api";

const artifactFields = new Set(["manifest", "reference", "config", "placeholder"]);

export function normalizeArtifact<Reference>(
  apiVersion: string,
  artifact: Artifact<Reference>,
): NormalizedArtifact<Reference> {
  const declaration = normalizePlainRecord(artifact, "Artifact declaration", {
    fields: artifactFields,
  });
  if (!Object.hasOwn(declaration, "manifest")) {
    throw new TypeError("Artifact declaration must define manifest");
  }
  if (!Object.hasOwn(declaration, "reference")) {
    throw new TypeError("Artifact declaration must define reference");
  }
  const declaredManifest = declaration.manifest;
  const reference = declaration.reference;
  const config = declaration.config;
  const declaredPlaceholder = declaration.placeholder;
  const manifest = defineManifest(declaredManifest);
  if (!satisfies(apiVersion, manifest.apiVersion)) {
    throw new PlatformError(
      "API_INCOMPATIBLE",
      `Manifest '${manifest.name}' requires API ${manifest.apiVersion}, Platform provides ${apiVersion}`,
    );
  }

  const placeholder =
    declaredPlaceholder === undefined
      ? undefined
      : normalizePlaceholder(manifest, declaredPlaceholder);
  return Object.freeze({
    manifest,
    reference,
    config,
    ...(placeholder ? { placeholder } : {}),
  });
}

// Match the loaded Plugin name to the authorized Manifest so code cannot enter under another identity.
export async function loadPlugin<Reference>(
  loader: Loader<Reference>,
  artifact: NormalizedArtifact<Reference>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let loaded: unknown;
  try {
    loaded = await loader.load(artifact.reference, signal);
  } catch (error) {
    if (isCancellationReason(signal, error)) throw error;
    throw new PlatformError(
      "MODULE_LOAD_FAILED",
      `Failed to load module for Manifest '${artifact.manifest.name}'`,
      { cause: error },
    );
  }
  signal.throwIfAborted();
  if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
    throw new PlatformError(
      "MODULE_INVALID",
      `Artifact '${artifact.manifest.name}' did not load a module`,
    );
  }

  let plugin: AnyPlugin;
  try {
    const candidate = Object.hasOwn(loaded, "default")
      ? (loaded as { readonly default: unknown }).default
      : undefined;
    plugin = normalizePluginCandidate(candidate);
  } catch (error) {
    throw new PlatformError(
      "MODULE_INVALID",
      `Module '${artifact.manifest.name}' does not default-export a valid Plugin`,
      { cause: error },
    );
  }
  assertArtifactIdentity(artifact.manifest, plugin, "module");
  return plugin;
}

function normalizePlaceholder(manifest: Manifest, placeholder: unknown) {
  const plugin = normalizePluginCandidate(placeholder);
  assertArtifactIdentity(manifest, plugin, "placeholder");
  return plugin;
}

function normalizePluginCandidate(candidate: unknown): AnyPlugin {
  return definePlugin(candidate as Plugin<unknown, Requirements, Provisions, unknown>);
}

function assertArtifactIdentity(
  manifest: Manifest,
  plugin: { readonly name: string },
  source: "module" | "placeholder",
) {
  if (plugin.name !== manifest.name) {
    const candidate = source === "module" ? "loaded Plugin" : "placeholder Plugin";
    throw new PlatformError(
      "ARTIFACT_IDENTITY",
      `Artifact Manifest '${manifest.name}' does not match ${candidate} '${plugin.name}'`,
    );
  }
}
