import type { ContractKind } from "./contracts";
import { rememberContractKind } from "./contract-registry";
import { DougongError } from "./errors";
import type { InstallationDeclaration, InstallationRecord } from "./installation";

// The dependency plan. Built fresh for every candidate state, never mutated:
// a transition compares two whole graphs rather than editing one in place, which
// is what makes rollback a matter of re-activating the old plan.
//
// Layers, not just a topological order. Everything in one layer has its
// dependencies satisfied by earlier layers and nothing in the layer depends on a
// sibling, so a layer can activate concurrently. `order` flattens the layers and
// gives shutdown its exact reverse.

/** Immutable validated dependency plan over one Host-wide installation graph. */
export class InstallationGraph {
  readonly #declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>;
  readonly #resolvedProviders: ReadonlyMap<
    InstallationRecord,
    ReadonlyMap<string, InstallationRecord>
  >;

  private constructor(
    declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
    readonly order: ReadonlyArray<InstallationRecord>,
    readonly layers: ReadonlyArray<ReadonlyArray<InstallationRecord>>,
    readonly providers: ReadonlyMap<string, InstallationRecord>,
    readonly dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
    readonly contractKinds: ReadonlyMap<string, ContractKind>,
    resolvedProviders: ReadonlyMap<InstallationRecord, ReadonlyMap<string, InstallationRecord>>,
  ) {
    this.#declarations = declarations;
    this.#resolvedProviders = resolvedProviders;
  }

  static build(
    source: Iterable<InstallationRecord>,
    committedKinds: ReadonlyMap<string, ContractKind>,
  ) {
    // Sorted by installation index so the plan is a function of the declarations
    // alone. Two Hosts given the same installs in the same order produce the
    // same layers, which is what makes an activation order reproducible rather
    // than dependent on Map iteration.
    const installations = [...source].sort((left, right) => left.index - right.index);
    const contractKinds = new Map(committedKinds);
    const providers = collectProviders(installations, contractKinds);
    const dependencies = connectRequirements(installations, providers, contractKinds);
    const { order, layers } = sortDependencies(
      installations,
      dependencies.dependents,
      dependencies.indegree,
    );

    return new InstallationGraph(
      new Map(installations.map((installation) => [installation, installation.declaration])),
      Object.freeze(order),
      Object.freeze(layers.map((layer) => Object.freeze(layer))),
      providers,
      dependencies.dependents,
      contractKinds,
      dependencies.resolvedProviders,
    );
  }

  declarationFor(installation: InstallationRecord) {
    const declaration = this.#declarations.get(installation);
    if (!declaration) throw new Error(`Installation '${installation.id}' is not in this plan`);
    return declaration;
  }

  providerFor(installation: InstallationRecord, serviceId: string) {
    return this.#resolvedProviders.get(installation)?.get(serviceId);
  }

  provider(serviceId: string) {
    return this.providers.get(serviceId);
  }

  /**
   * Transitive dependents in *both* plans. A Service being replaced has old
   * consumers that must stop and new ones that must start, and only the union
   * covers both — expanding in the current plan alone would leave an Instance
   * running against a dependency that no longer exists.
   */
  affectedByTransitionTo(other: InstallationGraph, changed: ReadonlySet<InstallationRecord>) {
    const affected = new Set<InstallationRecord>();
    this.#expand(changed, affected);
    other.#expand(changed, affected);
    return affected;
  }

  #expand(changed: ReadonlySet<InstallationRecord>, affected: Set<InstallationRecord>) {
    const queue = [...changed];
    const visited = new Set<InstallationRecord>();
    for (let index = 0; index < queue.length; index++) {
      const installation = queue[index];
      if (!installation) continue;
      if (visited.has(installation)) continue;
      visited.add(installation);
      affected.add(installation);
      for (const dependent of this.dependents.get(installation) ?? []) queue.push(dependent);
    }
  }
}

function collectProviders(
  installations: ReadonlyArray<InstallationRecord>,
  contractKinds: Map<string, ContractKind>,
) {
  const providers = new Map<string, InstallationRecord>();
  for (const installation of installations) {
    for (const token of Object.values(installation.declaration.plugin.provides)) {
      rememberContractKind(contractKinds, token);
      const previous = providers.get(token.id);
      if (previous) {
        throw new DougongError(
          "SERVICE_CONFLICT",
          `Service '${token.id}' is provided by both '${previous.id}' and '${installation.id}'`,
        );
      }
      providers.set(token.id, installation);
    }
  }
  return providers;
}

function connectRequirements(
  installations: ReadonlyArray<InstallationRecord>,
  providers: ReadonlyMap<string, InstallationRecord>,
  contractKinds: Map<string, ContractKind>,
) {
  const resolvedProviders = new Map<InstallationRecord, Map<string, InstallationRecord>>();
  const dependents = new Map<InstallationRecord, Set<InstallationRecord>>();
  const indegree = new Map(installations.map((installation) => [installation, 0]));

  for (const installation of installations) {
    for (const requirement of Object.values(installation.declaration.plugin.requires)) {
      const token = requirement.kind === "optional" ? requirement.service : requirement;
      rememberContractKind(contractKinds, token);
      if (token.kind === "extensionPoint") continue;

      const provider = providers.get(token.id);
      if (!provider) {
        if (requirement.kind === "optional") continue;
        throw new DougongError(
          "SERVICE_MISSING",
          `Installation '${installation.id}' requires missing Service '${token.id}'`,
        );
      }
      if (provider === installation) {
        throw new DougongError(
          "SERVICE_CYCLE",
          `Installation '${installation.id}' cannot require Service '${token.id}' that it provides`,
        );
      }

      const resolved = resolvedProviders.get(installation) ?? new Map();
      resolved.set(token.id, provider);
      resolvedProviders.set(installation, resolved);

      const targets = dependents.get(provider) ?? new Set();
      if (targets.has(installation)) continue;
      targets.add(installation);
      dependents.set(provider, targets);
      indegree.set(installation, (indegree.get(installation) ?? 0) + 1);
    }
  }
  return { resolvedProviders, dependents, indegree };
}

function sortDependencies(
  installations: ReadonlyArray<InstallationRecord>,
  dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
  indegree: Map<InstallationRecord, number>,
) {
  let frontier = installations.filter((installation) => indegree.get(installation) === 0);
  const order: InstallationRecord[] = [];
  const layers: InstallationRecord[][] = [];
  while (frontier.length) {
    frontier.sort((left, right) => left.index - right.index);
    const layer = frontier;
    frontier = [];
    layers.push(layer);
    order.push(...layer);
    for (const installation of layer) {
      for (const dependent of dependents.get(installation) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (!next) frontier.push(dependent);
      }
    }
  }

  if (order.length !== installations.length) {
    const cycle = findDependencyCycle(installations, dependents);
    throw new DougongError(
      "SERVICE_CYCLE",
      `Installation dependency cycle: ${cycle.map((installation) => installation.id).join(" -> ")}`,
    );
  }
  return { order, layers };
}

// Only runs once the topological sort has already proven a cycle exists. Its job
// is the error message, not the detection — walking the graph a second time to
// name the actual path costs nothing on a failure path and turns "there is a
// cycle" into something a reader can act on.
function findDependencyCycle(
  installations: ReadonlyArray<InstallationRecord>,
  dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
) {
  const visited = new Set<InstallationRecord>();
  const visiting = new Set<InstallationRecord>();
  const path: InstallationRecord[] = [];

  const visit = (installation: InstallationRecord): InstallationRecord[] | undefined => {
    visiting.add(installation);
    path.push(installation);

    for (const dependent of dependents.get(installation) ?? []) {
      if (visiting.has(dependent)) {
        const cycleStart = path.indexOf(dependent);
        return [...path.slice(cycleStart), dependent];
      }
      if (visited.has(dependent)) continue;
      const cycle = visit(dependent);
      if (cycle) return cycle;
    }

    path.pop();
    visiting.delete(installation);
    visited.add(installation);
    return undefined;
  };

  for (const installation of installations) {
    if (visited.has(installation)) continue;
    const cycle = visit(installation);
    if (cycle) return cycle;
  }

  throw new Error("Dependency graph is cyclic but no cycle path was found");
}
