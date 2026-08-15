import { PlatformError } from "./errors";
import type { RegistrationRecord } from "./registration";
import { matchesVersion } from "./manifest";
import type { NormalizedArtifact } from "./platform-api";
import type { PlatformChangeOperation } from "./platform-change-set";

interface Candidate<Reference> {
  readonly registration: RegistrationRecord<Reference>;
  readonly artifact: NormalizedArtifact<Reference>;
}

/** Validates the complete registration graph that would exist after a change. */
export function validateCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
) {
  const candidate = buildCandidateGraph(current, operations);
  assertAcyclic(candidate);
  assertActivatedDependencies(candidate);
}

function buildCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
) {
  const candidate = new Map<string, Candidate<Reference>>(
    [...current].map((registration) => [
      registration.name,
      { registration, artifact: registration.artifact },
    ]),
  );

  for (const operation of operations) {
    if (operation.kind === "register") {
      if (candidate.has(operation.registration.name)) {
        throw new PlatformError(
          "PLUGIN_DUPLICATE",
          `Plugin '${operation.registration.name}' is already registered`,
        );
      }
      candidate.set(operation.registration.name, {
        registration: operation.registration,
        artifact: operation.artifact,
      });
    } else if (operation.kind === "update") {
      candidate.set(operation.registration.name, {
        registration: operation.registration,
        artifact: operation.artifact,
      });
    } else {
      candidate.delete(operation.registration.name);
    }
  }
  return candidate;
}

function assertAcyclic<Reference>(candidate: ReadonlyMap<string, Candidate<Reference>>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, path: ReadonlyArray<string>) => {
    if (visiting.has(name)) {
      throw new PlatformError(
        "PLUGIN_CYCLE",
        `Plugin dependency cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;
    const current = candidate.get(name);
    if (!current) return;

    visiting.add(name);
    for (const dependency of Object.keys(current.artifact.manifest.dependencies)) {
      if (candidate.has(dependency)) visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of candidate.keys()) visit(name, []);
}

function assertActivatedDependencies<Reference>(
  candidate: ReadonlyMap<string, Candidate<Reference>>,
) {
  for (const { registration, artifact } of candidate.values()) {
    if (registration.status !== "activated") continue;
    for (const [name, range] of Object.entries(artifact.manifest.dependencies)) {
      const dependency = candidate.get(name);
      if (!dependency) {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_MISSING",
          `Activated plugin '${registration.name}' requires missing plugin '${name}'`,
        );
      }
      if (!matchesVersion(dependency.artifact.manifest.version, range)) {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_INCOMPATIBLE",
          `Plugin '${registration.name}' requires '${name}' ${range}, found ${dependency.artifact.manifest.version}`,
        );
      }
      if (dependency.registration.status !== "activated") {
        throw new PlatformError(
          "PLUGIN_DEPENDENCY_INACTIVE",
          `Activated plugin '${registration.name}' requires plugin '${name}' to be activated`,
        );
      }
    }
  }
}
