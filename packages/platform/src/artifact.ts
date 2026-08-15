import { definePlugin, type Provisions, type Requirements } from "@dougongjs/core";
import { PlatformError } from "./errors";
import type { Loader } from "./loader";
import { defineManifest, matchesVersion, type Manifest } from "./manifest";
import type { ErasedPlugin, NormalizedArtifact, Artifact } from "./platform-api";

/** Normalizes and validates one public Artifact declaration. */
export function normalizeArtifact<
  Reference,
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
>(
  apiVersion: string,
  artifact: Artifact<Reference, Config, Requires, Provides, ConfigInput>,
): NormalizedArtifact<Reference> {
  if (!artifact || typeof artifact !== "object") {
    throw new TypeError("Artifact must be an object");
  }
  const manifest = defineManifest(artifact.manifest);
  if (!matchesVersion(apiVersion, manifest.apiVersion)) {
    throw new PlatformError(
      "API_INCOMPATIBLE",
      `Manifest '${manifest.name}' requires API ${manifest.apiVersion}, Platform provides ${apiVersion}`,
    );
  }

  const placeholder =
    artifact.placeholder === undefined
      ? undefined
      : normalizePlaceholder(manifest, artifact.placeholder);
  return Object.freeze({
    manifest,
    reference: artifact.reference,
    config: artifact.config,
    ...(placeholder ? { placeholder } : {}),
  });
}

/** Resolves one normalized Artifact into its canonical Core Plugin. */
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
    if (isLoadCancellation(signal, error)) throw error;
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

  const candidate = (loaded as { default?: unknown }).default;
  let plugin: ErasedPlugin;
  try {
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

function isLoadCancellation(signal: AbortSignal, error: unknown) {
  if (!signal.aborted) return false;
  if (Object.is(error, signal.reason)) return true;
  return error instanceof Error && error.name === "AbortError";
}

function normalizePlaceholder(manifest: Manifest, placeholder: unknown) {
  const plugin = normalizePluginCandidate(placeholder);
  assertArtifactIdentity(manifest, plugin, "placeholder");
  return plugin;
}

/** The sole Platform boundary that validates and type-erases a Plugin candidate. */
function normalizePluginCandidate(candidate: unknown): ErasedPlugin {
  return definePlugin(candidate as ErasedPlugin);
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
