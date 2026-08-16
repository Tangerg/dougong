import { resolvePluginConfig } from "./configuration";
import type { ContractRegistryDraft } from "./contract-registry";
import { assertContract, type Event, type ExtensionPoint } from "./contracts";
import { ContributionRegistry, type ContributionView } from "./contribution-store";
import { DougongError, isCancellationReason } from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import type { InstallationGraph } from "./installation-graph";
import type { InstallationRecord, Instance } from "./installation";
import { Lifetime, type InstanceMeta, type LifetimePort, type Logger } from "./lifetime";
import type { ErasedPlugin, PluginContext, Requirements } from "./plugin";
import type { Publication } from "./resource";

interface PreparedActivation {
  readonly installation: InstallationRecord;
  readonly instance: Instance;
  readonly services: ReadonlyMap<string, unknown>;
}

interface RuntimeOptions {
  readonly hostName: string;
  readonly logger: Logger;
  readonly isInstalled: (installationId: string) => boolean;
  readonly report: (error: unknown) => void;
}

export class IncompleteActivationCleanupError extends AggregateError {}

/** Owns live Instances and the capabilities reachable from their Lifetimes. */
export class Runtime {
  readonly #hostName: string;
  readonly #logger: Logger;
  readonly #isInstalled: (installationId: string) => boolean;
  readonly #report: (error: unknown) => void;
  readonly #services = new Map<InstallationRecord, ReadonlyMap<string, unknown>>();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;
  #activationOrder: InstallationRecord[] = [];

  constructor(options: RuntimeOptions) {
    this.#hostName = options.hostName;
    this.#logger = options.logger;
    this.#isInstalled = options.isInstalled;
    this.#report = options.report;
    this.#contributions = new ContributionRegistry(options.report);
  }

  readService(provider: InstallationRecord, serviceId: string) {
    const services = this.#services.get(provider);
    return services?.has(serviceId)
      ? { found: true as const, value: services.get(serviceId) }
      : { found: false as const };
  }

  captureConfigs(installations: Iterable<InstallationRecord>) {
    const configs = new Map<InstallationRecord, unknown>();
    for (const installation of installations) {
      const instance = installation.instance;
      if (instance) configs.set(installation, instance.config);
    }
    return configs;
  }

  resetActivationState() {
    this.#services.clear();
    this.#activationOrder = [];
  }

  commitActivationOrder(order: ReadonlyArray<InstallationRecord>) {
    this.#activationOrder = order.slice();
  }

  deactivateAll() {
    return this.deactivate(new Set(this.#activationOrder));
  }

  async activate(
    plan: InstallationGraph,
    installations: ReadonlySet<InstallationRecord>,
    configs: ReadonlyMap<InstallationRecord, unknown>,
    contracts: ContractRegistryDraft,
  ) {
    const port = this.#createLifetimePort(contracts);
    for (const layer of plan.layers) {
      const candidates = layer.filter(
        (installation) => installations.has(installation) && !installation.instance,
      );
      if (!candidates.length) continue;

      const controller = new AbortController();
      const results = await Promise.allSettled(
        candidates.map(async (installation) => {
          try {
            const config = configs.has(installation)
              ? configs.get(installation)
              : await resolvePluginConfig(
                  installation.declaration.plugin.config,
                  installation.declaration.config,
                  installation.id,
                );
            return await this.#prepareActivation(
              plan,
              installation,
              config,
              controller.signal,
              port,
            );
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        }),
      );

      const errors = collectActivationFailures(results, controller.signal);
      const prepared = results
        .filter(
          (result): result is PromiseFulfilledResult<PreparedActivation> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      if (errors.length) {
        const cleanupErrors = await this.#disposePreparedActivations(prepared);
        const startupError =
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Installation startup layer failed");
        if (cleanupErrors.length) {
          throw new IncompleteActivationCleanupError(
            [startupError, ...cleanupErrors],
            "Installation startup layer failed and could not be cleanly disposed",
          );
        }
        throw startupError;
      }

      this.#commitActivations(prepared);
    }
  }

  async deactivate(installations: ReadonlySet<InstallationRecord>) {
    const errors: unknown[] = [];
    const order = this.#activationOrder
      .filter((installation) => installations.has(installation))
      .reverse();
    this.#activationOrder = this.#activationOrder.filter(
      (installation) => !installations.has(installation),
    );
    for (const installation of order) {
      const instance = installation.instance;
      if (!instance) continue;
      installation.beginStopping();
      this.#services.delete(installation);
      try {
        await instance.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        installation.deactivate();
      }
    }
    return errors;
  }

  async withContributionBatch<T>(operation: () => Promise<T>) {
    this.#contributions.beginBatch();
    let outcome:
      { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let publication: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
    try {
      this.#contributions.endBatch();
      publication = { ok: true };
    } catch (error) {
      publication = { ok: false, error };
    }
    if (!outcome.ok && !publication.ok) {
      throw new AggregateError(
        [outcome.error, publication.error],
        "Host operation and contribution publication failed",
      );
    }
    if (!outcome.ok) throw outcome.error;
    if (!publication.ok) throw publication.error;
    return outcome.value;
  }

  async #prepareActivation(
    plan: InstallationGraph,
    installation: InstallationRecord,
    config: unknown,
    startupSignal: AbortSignal,
    port: LifetimePort,
  ): Promise<PreparedActivation> {
    installation.deactivate();
    const plugin = installation.declaration.plugin;
    const lifetime = new Lifetime(port, installation.id, { parentSignal: startupSignal });

    try {
      const requirements = this.#resolveRequirements(plan, installation, plugin, lifetime);
      const meta: InstanceMeta = {
        hostName: this.#hostName,
        pluginName: plugin.name,
        installationId: installation.id,
        groupId: installation.groupId,
      };
      const context = this.#createContext(lifetime, meta, requirements);
      const output = await plugin.setup(context, config);
      const services = new Map<string, unknown>();
      for (const [alias, token] of Object.entries(plugin.provides ?? {})) {
        if (typeof output !== "object" || output === null || !Object.hasOwn(output, alias)) {
          throw new DougongError(
            "SERVICE_NOT_RETURNED",
            `Installation '${installation.id}' did not return provided Service '${alias}'`,
          );
        }
        services.set(token.id, (output as Record<string, unknown>)[alias]);
      }

      return Object.freeze({
        installation,
        instance: Object.freeze({ plugin, config, lifetime }),
        services,
      });
    } catch (error) {
      const failure = installation.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        throw new IncompleteActivationCleanupError(
          [failure, cleanupError],
          `Installation '${installation.id}' failed to start and could not be cleanly disposed`,
        );
      }
      throw failure;
    }
  }

  #commitActivations(candidates: ReadonlyArray<PreparedActivation>) {
    // Establish ownership for the complete layer before publishing any of its
    // resources. If publication exposes an internal invariant failure, reverse
    // activation cleanup can still find every prepared Instance in the layer.
    for (const { installation, instance, services } of candidates) {
      this.#services.set(installation, services);
      installation.activate(instance);
      this.#activationOrder.push(installation);
    }
    for (const { instance } of candidates) {
      instance.lifetime.publish();
      instance.lifetime.detachStartupSignal();
    }
  }

  async #disposePreparedActivations(candidates: ReadonlyArray<PreparedActivation>) {
    const errors: unknown[] = [];
    for (const candidate of [...candidates].reverse()) {
      try {
        await candidate.instance.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #resolveRequirements(
    plan: InstallationGraph,
    installation: InstallationRecord,
    plugin: ErasedPlugin,
    lifetime: Lifetime,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = Object.create(null);
    for (const [alias, requirement] of Object.entries(plugin.requires ?? {})) {
      if (requirement.kind === "optional") {
        const provider = plan.providerFor(installation, requirement.service.id);
        if (!provider) {
          values[alias] = undefined;
          continue;
        }
        const services = this.#services.get(provider);
        if (!services?.has(requirement.service.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Optional Service '${requirement.service.id}' is not active for Installation '${installation.id}'`,
          );
        }
        values[alias] = services.get(requirement.service.id);
      } else if (requirement.kind === "service") {
        const provider = plan.providerFor(installation, requirement.id);
        const services = provider ? this.#services.get(provider) : undefined;
        if (!provider || !services?.has(requirement.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Service '${requirement.id}' is not active for Installation '${installation.id}'`,
          );
        }
        values[alias] = services.get(requirement.id);
      } else {
        values[alias] = this.#contributionView(requirement, lifetime);
      }
    }
    return values;
  }

  #createContext(
    lifetime: Lifetime,
    meta: InstanceMeta,
    requirements: Record<string, unknown>,
  ): PluginContext<Requirements> {
    return Object.freeze({
      ...requirements,
      get signal() {
        return lifetime.signal;
      },
      meta: Object.freeze(meta),
      log: this.#logger,
      cleanup: lifetime.cleanup.bind(lifetime),
      lifetime: lifetime.lifetime.bind(lifetime),
      spawn: lifetime.spawn.bind(lifetime),
      on: lifetime.on.bind(lifetime),
      emit: lifetime.emit.bind(lifetime),
      contribute: lifetime.contribute.bind(lifetime),
    }) as PluginContext<Requirements>;
  }

  #createLifetimePort(contracts: ContractRegistryDraft): LifetimePort {
    return {
      stageOn: (ownerId, token, listener, release) => {
        return this.#stageOn(ownerId, token, listener, release, contracts);
      },
      emit: (ownerId, token, payload) => this.#emit(ownerId, token, payload, contracts),
      stageContribution: (ownerId, token, key, value, release) => {
        return this.#stageContribution(ownerId, token, key, value, release, contracts);
      },
      report: this.#report,
    };
  }

  #stageOn<T>(
    ownerId: string,
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
    contracts: ContractRegistryDraft,
  ) {
    this.#assertOwner(ownerId);
    assertContract(token, "event");
    contracts.remember(token);
    return this.#events.stage(token.id, listener, release);
  }

  #emit<T>(ownerId: string, token: Event<T>, payload: T, contracts: ContractRegistryDraft) {
    this.#assertOwner(ownerId);
    assertContract(token, "event");
    contracts.remember(token);
    return this.#events.emit(token.id, payload);
  }

  #stageContribution<T>(
    ownerId: string,
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
    contracts: ContractRegistryDraft,
  ) {
    this.#assertOwner(ownerId);
    assertContract(token, "extensionPoint");
    contracts.remember(token);
    return this.#contributions.get(token).stage(ownerId, key, value, release);
  }

  #contributionView<T>(token: ExtensionPoint<T>, lifetime: Lifetime): ContributionView<T> {
    return this.#contributions
      .get(token)
      .view((resource, kind) => lifetime.ownLease(resource, kind));
  }

  #assertOwner(ownerId: string) {
    if (!this.#isInstalled(ownerId)) {
      throw new Error(`Installation '${ownerId}' is not installed`);
    }
  }
}

function collectActivationFailures<T>(
  results: ReadonlyArray<PromiseSettledResult<T>>,
  signal: AbortSignal,
) {
  const errors: unknown[] = [];
  let rootObserved = false;
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    if (Object.is(result.reason, signal.reason)) {
      if (!rootObserved) errors.push(result.reason);
      rootObserved = true;
    } else if (!isCancellationReason(signal, result.reason)) {
      errors.push(result.reason);
    }
  }
  return errors;
}
