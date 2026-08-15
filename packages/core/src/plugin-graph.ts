import type { ContractKind } from "./contracts";
import { rememberContractKind } from "./contract-registry";
import { DougongError } from "./errors";
import type { InstallationRecord } from "./installation";

/** Immutable validated dependency plan over one application-wide capability graph. */
export class PluginGraph {
  readonly #resolvedProviders: ReadonlyMap<
    InstallationRecord,
    ReadonlyMap<string, InstallationRecord>
  >;

  private constructor(
    readonly order: ReadonlyArray<InstallationRecord>,
    readonly layers: ReadonlyArray<ReadonlyArray<InstallationRecord>>,
    readonly providers: ReadonlyMap<string, InstallationRecord>,
    readonly dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
    readonly contractKinds: ReadonlyMap<string, ContractKind>,
    resolvedProviders: ReadonlyMap<InstallationRecord, ReadonlyMap<string, InstallationRecord>>,
  ) {
    this.#resolvedProviders = resolvedProviders;
  }

  static build(
    source: Iterable<InstallationRecord>,
    committedKinds: ReadonlyMap<string, ContractKind>,
  ) {
    const installations = [...source].sort((left, right) => left.index - right.index);
    const contractKinds = new Map(committedKinds);
    const providers = collectProviders(installations, contractKinds);
    const dependencies = connectRequirements(installations, providers, contractKinds);
    const { order, layers } = sortDependencies(
      installations,
      dependencies.dependents,
      dependencies.indegree,
    );

    return new PluginGraph(
      Object.freeze(order),
      Object.freeze(layers.map((layer) => Object.freeze(layer))),
      providers,
      dependencies.dependents,
      contractKinds,
      dependencies.resolvedProviders,
    );
  }

  providerFor(installation: InstallationRecord, serviceId: string) {
    return this.#resolvedProviders.get(installation)?.get(serviceId);
  }

  provider(serviceId: string) {
    return this.providers.get(serviceId);
  }

  affectedByTransitionTo(other: PluginGraph, changed: ReadonlySet<InstallationRecord>) {
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
    for (const token of Object.values(installation.spec.plugin.provides ?? {})) {
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
    for (const requirement of Object.values(installation.spec.plugin.requires ?? {})) {
      const token = requirement.kind === "optional" ? requirement.service : requirement;
      rememberContractKind(contractKinds, token);
      if (token.kind === "extensionPoint") continue;

      const provider = providers.get(token.id);
      if (!provider) {
        if (requirement.kind === "optional") continue;
        throw new DougongError(
          "SERVICE_MISSING",
          `Plugin '${installation.id}' requires missing service '${token.id}'`,
        );
      }
      if (provider === installation) {
        throw new DougongError(
          "SERVICE_CYCLE",
          `Plugin '${installation.id}' cannot require service '${token.id}' that it provides`,
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
      `Plugin dependency cycle: ${cycle.map((installation) => installation.id).join(" -> ")}`,
    );
  }
  return { order, layers };
}

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

  throw new TypeError("Dependency graph is cyclic but no cycle path was found");
}
