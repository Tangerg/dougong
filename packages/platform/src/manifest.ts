import { satisfies, validate } from "compare-versions";
import { z } from "zod";
import { PlatformError } from "./errors";

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "cannot start or end with whitespace",
  });

const versionRange = identifier.refine(isVersionRange, "must be a valid semantic version range");

const manifestSchema = z
  .object({
    name: identifier,
    version: identifier.refine(validate, "must be a valid semantic version"),
    apiVersion: versionRange.default("*"),
    activation: z.array(identifier).default(["startup"]),
    permissions: z.array(identifier).default([]),
    dependencies: z.record(identifier, versionRange).default({}),
  })
  .strict();

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export function matchesVersion(version: string, range: string) {
  return range === "*" || satisfies(version, range);
}

function isVersionRange(range: string) {
  if (range === "*") return true;
  try {
    satisfies("0.0.0", range);
    return true;
  } catch {
    return false;
  }
}

export type PluginManifestInput = z.input<typeof manifestSchema>;

export function defineManifest(input: PluginManifestInput | PluginManifest): PluginManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    throw new PlatformError("MANIFEST_INVALID", z.prettifyError(result.error), {
      cause: result.error,
    });
  }

  const manifest = result.data;
  assertUnique(manifest.activation, "activation event", manifest.name);
  assertUnique(manifest.permissions, "permission", manifest.name);

  return Object.freeze({
    ...manifest,
    activation: Object.freeze([...manifest.activation]),
    permissions: Object.freeze([...manifest.permissions]),
    dependencies: Object.freeze({ ...manifest.dependencies }),
  });
}

function assertUnique(values: ReadonlyArray<string>, label: string, plugin: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PlatformError(
        "MANIFEST_INVALID",
        `Plugin '${plugin}' declares duplicate ${label} '${value}'`,
      );
    }
    seen.add(value);
  }
}
