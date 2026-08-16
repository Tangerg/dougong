import { PlatformError } from "./errors";
import type { RegistrationRecord } from "./registration";
import { matchesVersion } from "./manifest";
import type { NormalizedArtifact } from "./platform-api";
import type { PlatformChangeOperation } from "./platform-change-set";

interface Candidate<Reference> {
  readonly artifact: NormalizedArtifact<Reference>;
  readonly activated: boolean;
}

/** Validates the complete registration graph that would exist after a change. */
export function validateCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  activatedUpdates: ReadonlySet<RegistrationRecord<Reference>>,
) {
  const candidate = buildCandidateGraph(current, operations, activatedUpdates);
  assertAcyclic(candidate);
  assertActivatedDependencies(candidate);
}

function buildCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  activatedUpdates: ReadonlySet<RegistrationRecord<Reference>>,
) {
  const candidate = new Map<string, Candidate<Reference>>(
    [...current].map((registration) => [
      registration.manifestName,
      {
        artifact: registration.artifact,
        activated: registration.status === "activated",
      },
    ]),
  );

  for (const operation of operations) {
    if (operation.kind === "register") {
      if (candidate.has(operation.registration.manifestName)) {
        throw new PlatformError(
          "REGISTRATION_DUPLICATE",
          `Registration '${operation.registration.manifestName}' already exists`,
        );
      }
      candidate.set(operation.registration.manifestName, {
        artifact: operation.artifact,
        activated: false,
      });
    } else if (operation.kind === "update") {
      candidate.set(operation.registration.manifestName, {
        artifact: operation.artifact,
        activated: activatedUpdates.has(operation.registration),
      });
    } else {
      candidate.delete(operation.registration.manifestName);
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
        "REGISTRATION_CYCLE",
        `Registration dependency cycle: ${[...path, name].join(" -> ")}`,
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
  for (const [registrationName, { artifact, activated }] of candidate) {
    if (!activated) continue;
    for (const [name, range] of Object.entries(artifact.manifest.dependencies)) {
      const dependency = candidate.get(name);
      if (!dependency) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_MISSING",
          `Activated Registration '${registrationName}' requires missing Registration '${name}'`,
        );
      }
      if (!matchesVersion(dependency.artifact.manifest.version, range)) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
          `Registration '${registrationName}' requires Registration '${name}' ${range}, found ${dependency.artifact.manifest.version}`,
        );
      }
      if (!dependency.activated) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INACTIVE",
          `Activated Registration '${registrationName}' requires Registration '${name}' to be activated`,
        );
      }
    }
  }
}
