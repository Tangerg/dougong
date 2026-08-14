import type { ContractKind, Service } from "./contracts";
import { DougongError } from "./errors";
import type { PluginInstance } from "./plugin-instance";

export interface ServiceProvider {
  readonly instance: PluginInstance;
  readonly alias: string;
  readonly token: Service<unknown>;
}

/** Immutable validated dependency plan over one application-wide capability graph. */
export class PluginGraph {
  readonly #resolvedProviders: ReadonlyMap<PluginInstance, ReadonlyMap<string, ServiceProvider>>;

  private constructor(
    readonly order: ReadonlyArray<PluginInstance>,
    readonly layers: ReadonlyArray<ReadonlyArray<PluginInstance>>,
    readonly providers: ReadonlyMap<string, ServiceProvider>,
    readonly dependents: ReadonlyMap<PluginInstance, ReadonlySet<PluginInstance>>,
    readonly contractKinds: ReadonlyMap<string, ContractKind>,
    resolvedProviders: ReadonlyMap<PluginInstance, ReadonlyMap<string, ServiceProvider>>,
  ) {
    this.#resolvedProviders = resolvedProviders;
  }

  static build(
    installations: Iterable<PluginInstance>,
    committedKinds: ReadonlyMap<string, ContractKind>,
  ) {
    const instances = [...installations].sort((left, right) => left.index - right.index);
    const providers = new Map<string, ServiceProvider>();
    const resolvedProviders = new Map<PluginInstance, Map<string, ServiceProvider>>();
    const dependents = new Map<PluginInstance, Set<PluginInstance>>();
    const indegree = new Map(instances.map((instance) => [instance, 0]));
    const contractKinds = new Map(committedKinds);

    for (const instance of instances) {
      for (const [alias, token] of Object.entries(instance.spec.plugin.provides ?? {})) {
        rememberKind(contractKinds, token);
        const previous = providers.get(token.id);
        if (previous) {
          throw new DougongError(
            "SERVICE_CONFLICT",
            `Service '${token.id}' is provided by both '${previous.instance.id}' and '${instance.id}'`,
          );
        }
        providers.set(token.id, { instance, alias, token });
      }
    }

    for (const instance of instances) {
      for (const requirement of Object.values(instance.spec.plugin.requires ?? {})) {
        const token = requirement.kind === "optional" ? requirement.service : requirement;
        rememberKind(contractKinds, token);
        if (token.kind === "extension") continue;

        const provider = providers.get(token.id);
        if (!provider) {
          if (requirement.kind === "optional") continue;
          throw new DougongError(
            "SERVICE_MISSING",
            `Plugin '${instance.id}' requires missing service '${token.id}'`,
          );
        }

        const resolved = resolvedProviders.get(instance) ?? new Map();
        resolved.set(token.id, provider);
        resolvedProviders.set(instance, resolved);

        if (provider.instance === instance) {
          throw new DougongError(
            "SERVICE_CYCLE",
            `Plugin '${instance.id}' cannot require service '${token.id}' that it provides`,
          );
        }

        const targets = dependents.get(provider.instance) ?? new Set();
        if (targets.has(instance)) continue;
        targets.add(instance);
        dependents.set(provider.instance, targets);
        indegree.set(instance, (indegree.get(instance) ?? 0) + 1);
      }
    }

    let frontier = instances.filter((instance) => indegree.get(instance) === 0);
    const order: PluginInstance[] = [];
    const layers: PluginInstance[][] = [];
    while (frontier.length) {
      frontier.sort((left, right) => left.index - right.index);
      const layer = frontier;
      frontier = [];
      layers.push(layer);
      order.push(...layer);
      for (const instance of layer) {
        for (const dependent of dependents.get(instance) ?? []) {
          const next = (indegree.get(dependent) ?? 0) - 1;
          indegree.set(dependent, next);
          if (!next) frontier.push(dependent);
        }
      }
    }

    if (order.length !== instances.length) {
      const cycle = instances
        .filter((instance) => !order.includes(instance))
        .map((instance) => instance.id);
      throw new DougongError("SERVICE_CYCLE", `Plugin dependency cycle: ${cycle.join(" -> ")}`);
    }

    return new PluginGraph(
      Object.freeze(order),
      Object.freeze(layers.map((layer) => Object.freeze(layer))),
      providers,
      dependents,
      contractKinds,
      resolvedProviders,
    );
  }

  providerFor(instance: PluginInstance, serviceId: string) {
    return this.#resolvedProviders.get(instance)?.get(serviceId);
  }

  provider(serviceId: string) {
    return this.providers.get(serviceId);
  }

  affectedWith(other: PluginGraph, changed: ReadonlySet<PluginInstance>) {
    const affected = new Set<PluginInstance>();
    this.#expand(changed, affected);
    other.#expand(changed, affected);
    return affected;
  }

  #expand(changed: ReadonlySet<PluginInstance>, affected: Set<PluginInstance>) {
    const queue = [...changed];
    const visited = new Set<PluginInstance>();
    while (queue.length) {
      const instance = queue.shift()!;
      if (visited.has(instance)) continue;
      visited.add(instance);
      affected.add(instance);
      for (const dependent of this.dependents.get(instance) ?? []) queue.push(dependent);
    }
  }
}

function rememberKind(
  kinds: Map<string, ContractKind>,
  token: { readonly id: string; readonly kind: ContractKind },
) {
  const previous = kinds.get(token.id);
  if (previous && previous !== token.kind) {
    throw new DougongError(
      "CONTRACT_CONFLICT",
      `Contract '${token.id}' is used as both '${previous}' and '${token.kind}'`,
    );
  }
  kinds.set(token.id, token.kind);
}
