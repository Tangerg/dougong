import { satisfies } from "semver";
import { describeArtifact, type ArtifactDescriptor } from "../artifacts/artifact.js";
import type { Registration, RegistrationRecord, Selection } from "../catalog/registration.js";
import { PlatformError, type PlatformErrorCode } from "../errors.js";

export interface ActivationBlocker {
  readonly code: PlatformErrorCode;
  readonly message: string;
  readonly dependencyPath: ReadonlyArray<string>;
}

export interface ActivationPreview {
  readonly removals: ReadonlyArray<{
    readonly registrationId: string;
    readonly selectionRevision: number;
  }>;
  readonly selections: ReadonlyArray<{
    readonly registrationId: string;
    readonly selectionRevision: number;
    readonly artifact: ArtifactDescriptor;
    readonly action: "install" | "update" | "reuse";
  }>;
  readonly blockers: ReadonlyArray<ActivationBlocker>;
  readonly deferred: readonly [
    "admission",
    "module_validation",
    "configuration_validation",
    "core_binding",
    "setup",
  ];
}

export interface ActivationPreviewOptions<Reference> {
  readonly remove?: ReadonlyArray<Registration<Reference>>;
}

export interface ActivationOptions<Reference> extends ActivationPreviewOptions<Reference> {
  readonly signal?: AbortSignal;
}

export class ActivationPlan<Reference> {
  readonly selections: ReadonlyArray<Selection<Reference>>;
  readonly removals: ReadonlyArray<Selection<Reference>>;
  readonly report: ActivationPreview;

  constructor(
    registrations: ReadonlyMap<string, RegistrationRecord<Reference>>,
    roots: ReadonlyArray<RegistrationRecord<Reference>>,
    removing: ReadonlyArray<RegistrationRecord<Reference>> = [],
  ) {
    const selections: Selection<Reference>[] = [];
    const blockers: ActivationBlocker[] = [];
    const removed = new Set(removing);
    const selectedPaths = new Map<string, ReadonlyArray<string>>();

    const visit = (registration: RegistrationRecord<Reference>, path: ReadonlyArray<string>) => {
      const name = registration.name;
      if (removed.has(registration)) return;
      if (selectedPaths.has(name)) return;
      selectedPaths.set(name, [...path, name]);
      const selection = registration.capture();
      for (const dependencyName of Object.keys(selection.artifact.manifest.dependencies)) {
        const dependency = registrations.get(dependencyName);
        if (dependency) visit(dependency, [...path, name]);
      }
      selections.push(selection);
    };

    for (const root of roots) {
      if (removed.has(root)) {
        blockers.push(
          blocker(
            "REGISTRATION_DEPENDENCY_MISSING",
            `Activation requires removed Registration '${root.name}'`,
            [root.name],
          ),
        );
      } else {
        visit(root, []);
      }
    }
    const candidate = activeArtifacts(
      [...registrations.values()].filter((registration) => !removed.has(registration)),
    );
    for (const selection of selections)
      candidate.set(selection.registration.name, selection.artifact);
    blockers.push(...validateArtifacts(candidate, selectedPaths));

    this.selections = Object.freeze(selections);
    this.removals = Object.freeze(removing.map((registration) => registration.capture()));
    this.report = Object.freeze({
      removals: Object.freeze(
        this.removals.map((selection) =>
          Object.freeze({
            registrationId: selection.registration.id,
            selectionRevision: selection.revision,
          }),
        ),
      ),
      selections: Object.freeze(
        selections.map((selection) =>
          Object.freeze({
            registrationId: selection.registration.id,
            selectionRevision: selection.revision,
            artifact: describeArtifact(selection.artifact),
            action: selection.registration.actionFor(selection.artifact),
          }),
        ),
      ),
      blockers: Object.freeze(blockers),
      deferred: Object.freeze([
        "admission",
        "module_validation",
        "configuration_validation",
        "core_binding",
        "setup",
      ] as const),
    });
    Object.freeze(this);
  }

  assertValid() {
    assertNoBlockers(this.report.blockers);
  }

  assertCurrent() {
    for (const selection of [...this.selections, ...this.removals])
      selection.registration.assertCurrent(selection);
  }
}

function activeArtifacts<Reference>(registrations: Iterable<RegistrationRecord<Reference>>) {
  const result = new Map<string, ArtifactDescriptor>();
  for (const registration of registrations) {
    const origin = registration.activeOrigin;
    if (origin) result.set(registration.name, origin);
  }
  return result;
}

function validateArtifacts(
  candidate: ReadonlyMap<string, ArtifactDescriptor>,
  selectedPaths: ReadonlyMap<string, ReadonlyArray<string>>,
) {
  const blockers: ActivationBlocker[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, path: ReadonlyArray<string>) => {
    if (visiting.has(name)) {
      const cycle = [...path, name];
      blockers.push(
        blocker(
          "REGISTRATION_CYCLE",
          `Registration dependency cycle: ${cycle.join(" -> ")}`,
          cycle,
        ),
      );
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    const artifact = candidate.get(name)!;
    for (const [dependencyName, range] of Object.entries(artifact.manifest.dependencies)) {
      const dependency = candidate.get(dependencyName);
      const selectedPath = selectedPaths.get(name);
      const dependencyPath = [...(selectedPath ?? [name]), dependencyName];
      if (!dependency) {
        blockers.push(
          blocker(
            selectedPath ? "REGISTRATION_DEPENDENCY_MISSING" : "REGISTRATION_DEPENDENCY_INACTIVE",
            `Registration '${name}' requires '${dependencyName}' to be installed`,
            dependencyPath,
          ),
        );
      } else if (!satisfies(dependency.manifest.version, range)) {
        blockers.push(
          blocker(
            "REGISTRATION_DEPENDENCY_INCOMPATIBLE",
            `Registration '${name}' requires '${dependencyName}' ${range}, candidate ${dependency.manifest.version}`,
            dependencyPath,
          ),
        );
      }
      if (dependency) visit(dependencyName, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of candidate.keys()) visit(name, []);
  return blockers;
}

function blocker(
  code: ActivationBlocker["code"],
  message: string,
  dependencyPath: ReadonlyArray<string>,
): ActivationBlocker {
  return Object.freeze({ code, message, dependencyPath: Object.freeze([...dependencyPath]) });
}

function assertNoBlockers(blockers: ReadonlyArray<ActivationBlocker>) {
  if (!blockers.length) return;
  const errors = blockers.map(
    (item) =>
      new PlatformError(item.code, item.message, {
        details: {
          outcome: "rejected",
          phase: "artifact_planning",
          dependencyPath: item.dependencyPath,
        },
      }),
  );
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Activation is blocked");
}
