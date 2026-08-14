import { definePlugin, type Provisions, type Requirements } from "@dougongjs/core";
import { PlatformError } from "./errors";
import type { PluginLoader } from "./loader";
import { defineManifest, matchesVersion, type PluginManifest } from "./manifest";
import type { AnyPluginDefinition, NormalizedArtifact, PluginArtifact } from "./platform-api";

/** Normalizes and validates one host-facing artifact declaration. */
export function normalizeArtifact<
  Reference,
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
>(
  apiVersion: string,
  artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
): NormalizedArtifact<Reference> {
  if (!artifact || typeof artifact !== "object") {
    throw new TypeError("Plugin artifact must be an object");
  }
  const manifest = defineManifest(artifact.manifest);
  if (!matchesVersion(apiVersion, manifest.apiVersion)) {
    throw new PlatformError(
      "API_INCOMPATIBLE",
      `Plugin '${manifest.name}' requires API ${manifest.apiVersion}, host is ${apiVersion}`,
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

/** Resolves one normalized artifact into its canonical Core definition. */
export async function loadPluginDefinition<Reference>(
  loader: PluginLoader<Reference>,
  artifact: NormalizedArtifact<Reference>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let loaded: unknown;
  try {
    loaded = await loader.load(artifact.reference, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new PlatformError(
      "MODULE_LOAD_FAILED",
      `Failed to load plugin '${artifact.manifest.name}'`,
      { cause: error },
    );
  }
  signal.throwIfAborted();
  if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
    throw new PlatformError("MODULE_INVALID", `Plugin '${artifact.manifest.name}' has no module`);
  }

  const candidate = (loaded as { default?: unknown }).default;
  let definition: AnyPluginDefinition;
  try {
    definition = definePlugin(candidate as AnyPluginDefinition);
  } catch (error) {
    throw new PlatformError(
      "MODULE_INVALID",
      `Plugin '${artifact.manifest.name}' default export is not a plugin definition`,
      { cause: error },
    );
  }
  assertPluginIdentity(artifact.manifest, definition, "module");
  return definition;
}

function normalizePlaceholder(manifest: PluginManifest, placeholder: unknown) {
  const definition = definePlugin(placeholder as AnyPluginDefinition);
  assertPluginIdentity(manifest, definition, "placeholder");
  return definition;
}

function assertPluginIdentity(
  manifest: PluginManifest,
  definition: { readonly name: string },
  source: "module" | "placeholder",
) {
  if (definition.name !== manifest.name) {
    const mismatch = source === "module" ? "loaded plugin" : "placeholder is named";
    throw new PlatformError(
      "PLUGIN_IDENTITY",
      `Manifest '${manifest.name}' ${mismatch} '${definition.name}'`,
    );
  }
}
