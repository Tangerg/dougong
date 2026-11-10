import { satisfies } from "semver";
import { describeArtifact, type ArtifactDescriptor } from "../artifacts/artifact.js";
import type { Registration, RegistrationRecord, Selection } from "../catalog/registration.js";
import {
  PlatformError,
  registrationDependencyMissingCode,
  registrationDependencyIncompatibleCode,
  registrationDependencyInactiveCode,
  registrationCycleCode,
} from "../errors.js";

type ActivationBlockerCode =
  | typeof registrationDependencyMissingCode
  | typeof registrationDependencyIncompatibleCode
  | typeof registrationDependencyInactiveCode
  | typeof registrationCycleCode;

export interface ActivationBlocker {
  readonly code: ActivationBlockerCode;
  readonly message: string;
  readonly dependencyPath: ReadonlyArray<string>;
}

// Preview validates only the delivery graph; these checks run during activation itself.
const deferredChecks = Object.freeze([
  "admission",
  "moduleValidation",
  "configurationValidation",
  "coreBinding",
  "setup",
] as const);

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
  readonly deferred: typeof deferredChecks;
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
    const parents = new Map<string, string | undefined>();
    const admitted = roots.filter((root) => {
      if (!removed.has(root)) return true;
      blockers.push(
        blocker(
          registrationDependencyMissingCode,
          `Activation requires removed Registration '${root.name}'`,
          [root.name],
        ),
      );
      return false;
    });
    walk(
      admitted,
      function* (registration) {
        for (const name of Object.keys(registration.selectedArtifact.manifest.dependencies)) {
          const dependency = registrations.get(name);
          if (dependency && !removed.has(dependency)) yield dependency;
        }
      },
      {
        enter: (registration, parent) => parents.set(registration.name, parent?.name),
        leave: (registration) => selections.push(registration.capture()),
      },
    );
    const candidate = activeArtifacts(
      [...registrations.values()].filter((registration) => !removed.has(registration)),
    );
    for (const selection of selections)
      candidate.set(selection.registration.name, selection.artifact);
    validateArtifacts(candidate, parents, blockers);

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
      deferred: deferredChecks,
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

// A delivery graph may be deeper than the JS stack. Only a reported blocker needs a materialized path.
function walk<T>(
  roots: Iterable<T>,
  dependencies: (value: T) => Iterable<T>,
  events: {
    readonly enter?: (value: T, parent: T | undefined) => void;
    readonly leave?: (value: T) => void;
    readonly cycle?: (path: T[]) => void;
  },
) {
  const visited = new Set<T>();
  const active = new Map<T, number>();
  const stack: Array<{ value: T; edges: Iterator<T> }> = [];
  const enter = (value: T, parent?: T) => {
    if (visited.has(value)) return;
    const from = active.get(value);
    if (from !== undefined) {
      events.cycle?.([...stack.slice(from).map((frame) => frame.value), value]);
      return;
    }
    events.enter?.(value, parent);
    active.set(value, stack.length);
    stack.push({ value, edges: dependencies(value)[Symbol.iterator]() });
  };
  for (const root of roots) {
    enter(root);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edge = frame.edges.next();
      if (!edge.done) enter(edge.value, frame.value);
      else {
        stack.pop();
        active.delete(frame.value);
        visited.add(frame.value);
        events.leave?.(frame.value);
      }
    }
  }
}

function validateArtifacts(
  candidate: ReadonlyMap<string, ArtifactDescriptor>,
  parents: ReadonlyMap<string, string | undefined>,
  blockers: ActivationBlocker[],
) {
  const dependencyPath = (name: string, dependency: string) => {
    const path = [dependency, name];
    for (let parent = parents.get(name); parent !== undefined; parent = parents.get(parent))
      path.push(parent);
    return path.reverse();
  };
  walk(
    candidate.keys(),
    function* (name) {
      const artifact = candidate.get(name)!;
      for (const [dependencyName, range] of Object.entries(artifact.manifest.dependencies)) {
        const dependency = candidate.get(dependencyName);
        if (!dependency) {
          blockers.push(
            blocker(
              parents.has(name)
                ? registrationDependencyMissingCode
                : registrationDependencyInactiveCode,
              `Registration '${name}' requires '${dependencyName}' to be installed`,
              dependencyPath(name, dependencyName),
            ),
          );
        } else {
          if (!satisfies(dependency.manifest.version, range))
            blockers.push(
              blocker(
                registrationDependencyIncompatibleCode,
                `Registration '${name}' requires '${dependencyName}' ${range}, candidate ${dependency.manifest.version}`,
                dependencyPath(name, dependencyName),
              ),
            );
          yield dependencyName;
        }
      }
    },
    {
      cycle: (path) =>
        blockers.push(
          blocker(
            registrationCycleCode,
            `Registration dependency cycle: ${path.join(" -> ")}`,
            path,
          ),
        ),
    },
  );
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
          phase: "artifactPlanning",
          dependencyPath: item.dependencyPath,
        },
      }),
  );
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Activation is blocked");
}
