import { PlatformError } from "./errors";
import type { RegistrationRecord } from "./registration";
import { matchesVersion } from "./manifest";
import type { NormalizedArtifact } from "./platform-api";
import type { PlatformChangeOperation } from "./platform-change-set";

interface Candidate<Reference> {
  readonly artifact: NormalizedArtifact<Reference>;
  readonly installed: boolean;
}

// Validates the graph a change *would* produce, before any of it is applied.
//
// Building the whole candidate state and checking that is what makes batches
// work: registering A which depends on B, and B, in one change is valid, even
// though neither is valid alone. Per-operation checks would reject it.
//
// Only installed Registrations have their dependencies enforced. A registered
// but inactive one is a declaration nobody is running yet, so a missing
// dependency is a future problem, not a present one — enforcing it here would
// make registration order matter.

/** Validates the complete registration graph that would exist after a change. */
export function validateCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  installedUpdates: ReadonlySet<RegistrationRecord<Reference>>,
) {
  const candidate = buildCandidateGraph(current, operations, installedUpdates);
  assertAcyclic(candidate);
  assertInstalledDependencies(candidate);
}

function buildCandidateGraph<Reference>(
  current: Iterable<RegistrationRecord<Reference>>,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  installedUpdates: ReadonlySet<RegistrationRecord<Reference>>,
) {
  const candidate = new Map<string, Candidate<Reference>>(
    [...current].map((registration) => [
      registration.manifestName,
      {
        artifact: registration.artifact,
        installed: registration.status === "installed",
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
        installed: false,
      });
    } else if (operation.kind === "update") {
      candidate.set(operation.registration.manifestName, {
        artifact: operation.artifact,
        installed: installedUpdates.has(operation.registration),
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
    // Unknown dependencies are skipped rather than reported. Whether a missing
    // dependency matters is `assertInstalledDependencies`' decision; this
    // function only answers whether the edges that do exist form a cycle.
    for (const dependency of Object.keys(current.artifact.manifest.dependencies)) {
      if (candidate.has(dependency)) visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of candidate.keys()) visit(name, []);
}

function assertInstalledDependencies<Reference>(
  candidate: ReadonlyMap<string, Candidate<Reference>>,
) {
  for (const [registrationName, { artifact, installed }] of candidate) {
    if (!installed) continue;
    for (const [name, range] of Object.entries(artifact.manifest.dependencies)) {
      const dependency = candidate.get(name);
      if (!dependency) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_MISSING",
          `Installed Registration '${registrationName}' requires missing Registration '${name}'`,
        );
      }
      if (!matchesVersion(dependency.artifact.manifest.version, range)) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
          `Registration '${registrationName}' requires Registration '${name}' ${range}, found ${dependency.artifact.manifest.version}`,
        );
      }
      if (!dependency.installed) {
        throw new PlatformError(
          "REGISTRATION_DEPENDENCY_INACTIVE",
          `Installed Registration '${registrationName}' requires Registration '${name}' to be installed`,
        );
      }
    }
  }
}
