// Manifest policy must run before import so denied code cannot execute during admission.

import { satisfies, valid, validRange } from "semver";
import { z } from "zod";
import { normalizePlainRecord } from "@dougongjs/core";
import { PlatformError } from "./errors";

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "cannot start or end with whitespace",
  });

const versionRange = identifier.refine(
  (range) => validRange(range) !== null,
  "must be a valid semantic version range",
);

const manifestSchema = z
  .object({
    name: identifier,
    version: identifier.refine(isConcreteVersion, "must be a valid semantic version"),
    apiVersion: versionRange.default("*"),
    activation: z.array(identifier).default(["startup"]),
    permissions: z.array(identifier).default([]),
    dependencies: z.record(identifier, versionRange).default({}),
  })
  .strict();

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly activation: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export function isConcreteVersion(version: string) {
  return version === version.trim() && valid(version) !== null;
}

export function matchesVersion(version: string, range: string) {
  return satisfies(version, range);
}

export type ManifestInput = z.input<typeof manifestSchema>;

// Only declaration validation grants error provenance; copied constructors cannot.
const manifestDeclarationFailures = new WeakSet<object>();

function manifestDeclarationError(message: string) {
  const failure = new PlatformError("MANIFEST_INVALID", message);
  Object.freeze(failure);
  manifestDeclarationFailures.add(failure);
  return failure;
}

// Untrusted manifests can crash validators; preserve the cause under one public failure code.
export function defineManifest(input: ManifestInput | Manifest): Manifest {
  let declaration: Readonly<Record<string, unknown>>;
  try {
    declaration = snapshotManifestDeclaration(input);
  } catch (error) {
    if (error !== null && typeof error === "object" && manifestDeclarationFailures.has(error))
      throw error;
    throw new PlatformError("MANIFEST_INVALID", "Manifest declaration could not be read", {
      cause: error,
    });
  }

  let result: ReturnType<typeof manifestSchema.safeParse>;
  try {
    result = manifestSchema.safeParse(declaration);
  } catch (error) {
    throw new PlatformError("MANIFEST_INVALID", "Manifest declaration could not be validated", {
      cause: error,
    });
  }
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

// Own the validated data so the supplier cannot mutate it between validation and storage.
function snapshotManifestDeclaration(input: unknown) {
  const declaration = normalizePlainRecord(input, "Manifest declaration", {
    createError: manifestDeclarationError,
  });
  if (declaration.dependencies !== undefined) {
    const dependencies = normalizePlainRecord(declaration.dependencies, "Manifest dependencies", {
      createError: manifestDeclarationError,
    });
    if (Object.hasOwn(dependencies, "__proto__")) {
      throw manifestDeclarationError("Manifest dependency '__proto__' is not supported");
    }
    return { ...declaration, dependencies };
  }
  return declaration;
}

function assertUnique(values: ReadonlyArray<string>, label: string, manifestName: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PlatformError(
        "MANIFEST_INVALID",
        `Manifest '${manifestName}' declares duplicate ${label} '${value}'`,
      );
    }
    seen.add(value);
  }
}
