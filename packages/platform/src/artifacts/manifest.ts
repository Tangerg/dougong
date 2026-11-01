// Manifest policy must run before import so denied code cannot execute during admission.

import { valid, validRange } from "semver";
import { z } from "zod";
import { captureConfig } from "dougong";
import { normalizePlainRecord } from "dougong/advanced";
import { PlatformError } from "../errors.js";

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "cannot start or end with whitespace",
  });

// Both components of an Installation ID are URI encoded; malformed UTF-16 cannot identify a Registration.
export function isRegistrationIdPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length !== 0 &&
    value.trim() === value &&
    value.isWellFormed()
  );
}

const registrationName = z
  .string()
  .refine(isRegistrationIdPart, "must be a non-empty trimmed Unicode identifier");

const versionRange = identifier.refine(
  (range) => validRange(range) !== null,
  "must be a valid semantic version range",
);

const manifestSchema = z
  .object({
    name: registrationName,
    version: identifier.refine(isConcreteVersion, "must be a valid semantic version"),
    apiVersion: versionRange.default("*"),
    activation: z.array(identifier).default(["startup"]),
    permissions: z.array(identifier).default([]),
    dependencies: z.record(registrationName, versionRange).default({}),
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

export type ManifestInput = z.input<typeof manifestSchema>;

// Untrusted manifests can crash validators; preserve the cause under one public failure code.
export function defineManifest(input: ManifestInput | Manifest): Manifest {
  let failure: PlatformError | undefined;
  const declarationError = (message: string) =>
    (failure = Object.freeze(new PlatformError("MANIFEST_INVALID", message)));
  let declaration: Readonly<Record<string, unknown>>;
  try {
    declaration = snapshotManifestDeclaration(input, declarationError);
  } catch (error) {
    // A supplier may rethrow a genuine declaration error from an earlier call.
    if (failure && error === failure) throw failure;
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

  Object.freeze(manifest.activation);
  Object.freeze(manifest.permissions);
  Object.freeze(manifest.dependencies);
  return Object.freeze(manifest);
}

// Own the validated data so the supplier cannot mutate it between validation and storage.
function snapshotManifestDeclaration(input: unknown, createError: (message: string) => Error) {
  const declaration = normalizePlainRecord(input, "Manifest declaration", {
    createError,
  });
  const collections = {
    activation: captureConfig(declaration.activation),
    permissions: captureConfig(declaration.permissions),
  };
  if (declaration.dependencies !== undefined) {
    const dependencies = normalizePlainRecord(declaration.dependencies, "Manifest dependencies", {
      createError,
    });
    if (Object.hasOwn(dependencies, "__proto__")) {
      throw createError("Manifest dependency '__proto__' is not supported");
    }
    return { ...declaration, ...collections, dependencies };
  }
  return { ...declaration, ...collections };
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
