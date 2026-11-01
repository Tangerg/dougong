import type { ContractKind } from "../contracts/contracts.js";
import { rememberContractKind } from "../contracts/contract-registry.js";
import { DougongError } from "../contracts/errors.js";
import type { InstallationDeclaration, InstallationRecord } from "./installation.js";

// Immutable candidate plans preserve the previous declaration versions for rollback.

export class InstallationGraph {
  private constructor(
    readonly declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
    readonly byId: ReadonlyMap<string, InstallationRecord>,
    readonly order: ReadonlyArray<InstallationRecord>,
    readonly layers: ReadonlyArray<ReadonlyArray<InstallationRecord>>,
    readonly providers: ReadonlyMap<string, InstallationRecord>,
    readonly dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
    readonly contractKinds: ReadonlyMap<string, ContractKind>,
  ) {}

  static build(declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>) {
    const installations = [...declarations.keys()];
    const contractKinds = new Map<string, ContractKind>();
    const providers = collectProviders(declarations, contractKinds);
    const dependencies = connectRequirements(declarations, providers, contractKinds);
    const { order, layers } = sortDependencies(
      installations,
      dependencies.dependents,
      dependencies.indegree,
    );

    return new InstallationGraph(
      declarations,
      new Map(installations.map((installation) => [installation.id, installation])),
      Object.freeze(order),
      Object.freeze(layers.map((layer) => Object.freeze(layer))),
      providers,
      dependencies.dependents,
      contractKinds,
    );
  }

  declarationFor(installation: InstallationRecord) {
    const declaration = this.declarations.get(installation);
    if (!declaration) throw new Error(`Installation '${installation.id}' is not in this plan`);
    return declaration;
  }

  // Use both plans because replacing a Service affects both its old consumers and its new consumers.
  affectedByTransitionTo(other: InstallationGraph, changed: ReadonlyArray<InstallationRecord>) {
    const affected = new Set<InstallationRecord>();
    this.#expand(changed, affected);
    other.#expand(changed, affected);
    return affected;
  }

  #expand(changed: ReadonlyArray<InstallationRecord>, affected: Set<InstallationRecord>) {
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
  declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
  contractKinds: Map<string, ContractKind>,
) {
  const providers = new Map<string, InstallationRecord>();
  for (const [installation, declaration] of declarations) {
    for (const token of Object.values(declaration.plugin.provides)) {
      rememberContractKind(contractKinds, token);
      const previous = providers.get(token.id);
      if (previous) {
        throw new DougongError(
          "SERVICE_CONFLICT",
          `Service '${token.id}' is provided by both '${previous.id}' and '${installation.id}'`,
          {
            details: {
              outcome: "rejected",
              contract: token.id,
              affectedInstallations: [previous.id, installation.id],
            },
          },
        );
      }
      providers.set(token.id, installation);
    }
  }
  return providers;
}

function connectRequirements(
  declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
  providers: ReadonlyMap<string, InstallationRecord>,
  contractKinds: Map<string, ContractKind>,
) {
  const dependents = new Map<InstallationRecord, Set<InstallationRecord>>();
  const indegree = new Map([...declarations.keys()].map((installation) => [installation, 0]));

  for (const [installation, declaration] of declarations) {
    for (const requirement of Object.values(declaration.plugin.requires)) {
      const token = requirement.kind === "optional" ? requirement.service : requirement;
      rememberContractKind(contractKinds, token);
      if (token.kind === "extensionPoint") continue;

      const provider = providers.get(token.id);
      if (!provider) {
        if (requirement.kind === "optional") continue;
        throw new DougongError(
          "SERVICE_MISSING",
          `Installation '${installation.id}' requires missing Service '${token.id}'`,
          { details: { outcome: "rejected", installation: installation.id, contract: token.id } },
        );
      }
      if (provider === installation) {
        throw new DougongError(
          "SERVICE_CYCLE",
          `Installation '${installation.id}' cannot require Service '${token.id}' that it provides`,
          {
            details: {
              outcome: "rejected",
              installation: installation.id,
              contract: token.id,
              dependencyPath: [installation.id, installation.id],
            },
          },
        );
      }

      const targets = dependents.get(provider) ?? new Set();
      if (targets.has(installation)) continue;
      targets.add(installation);
      dependents.set(provider, targets);
      indegree.set(installation, (indegree.get(installation) ?? 0) + 1);
    }
  }
  return { dependents, indegree };
}

function sortDependencies(
  installations: ReadonlyArray<InstallationRecord>,
  dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
  indegree: Map<InstallationRecord, number>,
) {
  // Independent peers follow committed declaration order, even if their drafts were staged in reverse.
  const positions = new Map(installations.map((installation, index) => [installation, index]));
  let frontier = installations.filter((installation) => indegree.get(installation) === 0);
  const order: InstallationRecord[] = [];
  const layers: InstallationRecord[][] = [];
  while (frontier.length) {
    frontier.sort((left, right) => positions.get(left)! - positions.get(right)!);
    const layer = frontier;
    frontier = [];
    layers.push(layer);
    for (const installation of layer) {
      order.push(installation);
      for (const dependent of dependents.get(installation) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (!next) frontier.push(dependent);
      }
    }
  }

  if (order.length !== installations.length) {
    const cycle = findDependencyCycle(dependents, indegree);
    throw new DougongError(
      "SERVICE_CYCLE",
      `Installation dependency cycle: ${cycle.map((installation) => installation.id).join(" -> ")}`,
      {
        details: {
          outcome: "rejected",
          dependencyPath: cycle.map((installation) => installation.id),
        },
      },
    );
  }
  return { order, layers };
}

// After topological sorting, every remaining node has a remaining predecessor. Following
// those edges must revisit a node; reverse that segment to report provider → consumer order.
function findDependencyCycle(
  dependents: ReadonlyMap<InstallationRecord, ReadonlySet<InstallationRecord>>,
  indegree: ReadonlyMap<InstallationRecord, number>,
) {
  const predecessor = new Map<InstallationRecord, InstallationRecord>();
  for (const [provider, consumers] of dependents) {
    if (!indegree.get(provider)) continue;
    for (const consumer of consumers) predecessor.set(consumer, provider);
  }
  let current = predecessor.keys().next().value!;
  const visited = new Map<InstallationRecord, number>();
  while (!visited.has(current)) {
    visited.set(current, visited.size);
    current = predecessor.get(current)!;
  }
  return [...Array.from(visited.keys()).slice(visited.get(current)!), current].reverse();
}
