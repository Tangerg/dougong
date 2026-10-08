// What an Artifact claims about itself, before anything is loaded.
//
// A Manifest is data, so it can be read, cached and authorized without importing
// a single line of the code it describes. That ordering is the reason permissions
// are meaningful at all: policy decides on the declaration, not on the module.
//
// `.strict()` rejects unknown fields rather than ignoring them, so a typo in a
// manifest is an error the author sees instead of a setting that silently does
// nothing.

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

// Only our declaration checks grant provenance, independent of Error classes
// and constructors reachable through a previously returned error.
const manifestDeclarationFailures = new WeakSet<object>();

function manifestDeclarationError(message: string) {
  const failure = new PlatformError("MANIFEST_INVALID", message);
  Object.freeze(failure);
  manifestDeclarationFailures.add(failure);
  return failure;
}

/**
 * Every failure here is one `MANIFEST_INVALID`, whatever went wrong inside.
 *
 * A manifest may come from a file, a registry response or another process, so
 * zod itself can throw on input it was not built to see. Wrapping all three
 * paths — unreadable declaration, validator crash, validation failure — means a
 * caller has one code to handle, with the original always kept as `cause`.
 */
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

// Copied to own data before validation, because the object may be shared with
// whoever supplied it. Validating one object and storing another that has since
// been mutated is exactly the gap this closes.
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
