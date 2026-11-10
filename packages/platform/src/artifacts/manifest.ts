// Manifest policy must run before import so denied code cannot execute during admission.

import { valid, validRange } from "semver";
import { z } from "zod";
import { captureConfiguration } from "dougong";
import { normalizePlainRecord } from "dougong/advanced";
import { PlatformError, manifestInvalidCode } from "../errors.js";

// Platform names compare by exact string, so surrounding whitespace would create look-alike identities.
export function isTrimmedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

// Both components of an Installation ID are URI encoded; malformed UTF-16 cannot identify a Registration.
export function isRegistrationIdPart(value: unknown): value is string {
  return isTrimmedText(value) && value.isWellFormed();
}

export const startupActivationEvent = "startup";

const identifier = z
  .string()
  .refine(isTrimmedText, { error: "must be a non-empty string without surrounding whitespace" });

const registrationName = z
  .string()
  .refine(isRegistrationIdPart, { error: "must be a non-empty trimmed Unicode identifier" });

const versionRange = identifier.refine((range) => validRange(range) !== null, {
  error: "must be a valid semantic version range",
});

// A Map validates arbitrary Registration names without invoking or stripping Object prototype keys.
const dependencyRanges = z
  .preprocess(
    (dependencies: Record<string, string>) => new Map(Object.entries(dependencies)),
    z.map(registrationName, versionRange),
  )
  .transform((dependencies) => Object.fromEntries(dependencies));

const manifestSchema = z
  .strictObject({
    name: registrationName,
    version: identifier.refine(isConcreteVersion, { error: "must be a valid semantic version" }),
    apiVersion: versionRange.default("*"),
    activation: z.array(identifier).default([startupActivationEvent]).readonly(),
    permissions: z.array(identifier).default([]).readonly(),
    dependencies: dependencyRanges.default({}).readonly(),
  })
  .readonly();

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestInput = z.input<typeof manifestSchema>;

export function isConcreteVersion(version: string) {
  return isTrimmedText(version) && valid(version) !== null;
}

// Untrusted manifests can crash validators; preserve the cause under one public failure code.
export function defineManifest(input: ManifestInput): Manifest {
  let failure: PlatformError | undefined;
  const declarationError = (message: string) =>
    (failure = Object.freeze(new PlatformError(manifestInvalidCode, message)));
  let declaration: Readonly<Record<string, unknown>>;
  try {
    declaration = snapshotManifestDeclaration(input, declarationError);
  } catch (error) {
    // A supplier may rethrow a genuine declaration error from an earlier call.
    if (failure && error === failure) throw failure;
    throw new PlatformError(manifestInvalidCode, "Manifest declaration could not be read", {
      cause: error,
    });
  }

  const manifest = validateManifest(declaration);
  assertUnique(manifest.activation, "activation event", manifest.name);
  assertUnique(manifest.permissions, "permission", manifest.name);

  return manifest;
}

// Error maps run lazily, so the validation boundary must also own error materialization.
function validateManifest(declaration: Readonly<Record<string, unknown>>): Manifest {
  let failure: PlatformError;
  try {
    const result = manifestSchema.safeParse(declaration);
    if (result.success) return result.data;
    const cause = result.error;
    failure = new PlatformError(manifestInvalidCode, z.prettifyError(cause), { cause });
  } catch (error) {
    throw new PlatformError(manifestInvalidCode, "Manifest declaration could not be validated", {
      cause: error,
    });
  }
  throw failure;
}

// Own the validated data so the supplier cannot mutate it between validation and storage.
function snapshotManifestDeclaration(input: unknown, createError: (message: string) => Error) {
  const declaration = normalizePlainRecord(input, "Manifest declaration", {
    createError,
  });
  const collections = {
    activation: captureConfiguration(declaration.activation),
    permissions: captureConfiguration(declaration.permissions),
  };
  if (declaration.dependencies !== undefined) {
    const dependencies = normalizePlainRecord(declaration.dependencies, "Manifest dependencies", {
      createError,
    });
    return { ...declaration, ...collections, dependencies };
  }
  return { ...declaration, ...collections };
}

function assertUnique(values: ReadonlyArray<string>, label: string, manifestName: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PlatformError(
        manifestInvalidCode,
        `Manifest '${manifestName}' declares duplicate ${label} '${value}'`,
      );
    }
    seen.add(value);
  }
}
