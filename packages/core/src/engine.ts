import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ContractRegistry, type ContractRegistryDraft } from "./contract-registry";
import { assertContract, type Event, type ExtensionPoint, type Service } from "./contracts";
import {
  ConfigValidationError,
  DougongError,
  isCancellationReason,
  normalizeFailure,
  type ValidationIssue,
} from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import { ContributionRegistry, type ContributionView } from "./contribution-store";
import { Lifetime, type InstanceMeta, type LifetimePort, type Logger } from "./lifetime";
import { InstallationGraph } from "./installation-graph";
import type { InstallationRecord, Instance } from "./installation";
import type { ErasedPlugin, PluginContext, Requirements } from "./plugin";
import type { Publication } from "./resource";

export type TransitionOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<InstallationRecord> }
  | {
      readonly kind: "rolled-back";
      readonly affected: ReadonlySet<InstallationRecord>;
      readonly error: unknown;
    };

interface PreparedActivation {
  readonly installation: InstallationRecord;
  readonly instance: Instance;
  readonly services: ReadonlyMap<string, unknown>;
}

interface EngineOptions {
  readonly hostName: string;
  readonly logger: Logger;
  readonly isInstalled: (installationId: string) => boolean;
  readonly report: (error: unknown) => void;
}

type ServiceAvailability = "available" | "unavailable";

class IncompleteActivationCleanupError extends AggregateError {}

/**
 * Owns committed execution state: contracts, services, events, contributions,
 * Lifetimes, Instances and graph transitions. The Host owns Installation
 * declarations and command serialization; neither side duplicates the other's
 * state.
 */
export class Engine {
  readonly #hostName: string;
  readonly #logger: Logger;
  readonly #isInstalled: (installationId: string) => boolean;
  readonly #report: (error: unknown) => void;
  readonly #services = new Map<InstallationRecord, ReadonlyMap<string, unknown>>();
  readonly #contracts = new ContractRegistry();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;

  #plan: InstallationGraph | undefined;
  #activationOrder: InstallationRecord[] = [];

  constructor(options: EngineOptions) {
    this.#hostName = options.hostName;
    this.#logger = options.logger;
    this.#isInstalled = options.isInstalled;
    this.#report = options.report;
    this.#contributions = new ContributionRegistry(options.report);
  }

  get hasCommittedPlan() {
    return this.#plan !== undefined;
  }

  get<T>(token: Service<T>, availability: ServiceAvailability): T {
    assertContract(token, "service");
    this.#contracts.assertCompatible(token);
    if (availability === "unavailable") {
      throw hostServicesUnavailable();
    }
    const provider = this.#requirePlan().provider(token.id);
    const services = provider ? this.#services.get(provider) : undefined;
    if (!provider || !services?.has(token.id)) {
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    return services.get(token.id) as T;
  }

  buildPlan(installations: Iterable<InstallationRecord>) {
    return InstallationGraph.build(installations, this.#contracts.kinds);
  }

  async start(plan: InstallationGraph) {
    const contracts = this.#contracts.draft(plan.contractKinds);
    try {
      await this.#withContributionBatch(() => this.#activateInitialPlan(plan, contracts));
      this.#plan = plan;
    } catch (error) {
      contracts.discard();
      this.#plan = undefined;
      throw error;
    }
  }

  async stop() {
    const errors = await this.#withContributionBatch(() =>
      this.#deactivateInstallations(new Set(this.#activationOrder)),
    );
    this.#plan = undefined;
    return errors;
  }

  async transition(
    nextPlan: InstallationGraph,
    changed: ReadonlySet<InstallationRecord>,
    restoreDeclarations: () => void,
  ): Promise<TransitionOutcome> {
    return this.#withContributionBatch(async () => {
      const previousPlan = this.#requirePlan();
      const affected = previousPlan.affectedByTransitionTo(nextPlan, changed);
      let nextConfigs: ReadonlyMap<InstallationRecord, unknown>;
      let contracts: ContractRegistryDraft;
      try {
        nextConfigs = await this.#resolveConfigs(
          nextPlan.order.filter((installation) => affected.has(installation)),
        );
        contracts = this.#contracts.draft(nextPlan.contractKinds);
      } catch (error) {
        restoreDeclarations();
        throw error;
      }

      const previousConfigs = new Map<InstallationRecord, unknown>();
      for (const installation of affected) {
        const instance = installation.instance;
        if (instance) previousConfigs.set(installation, instance.config);
      }

      const stopErrors = await this.#deactivateInstallations(affected);
      if (stopErrors.length) {
        contracts.discard();
        return this.#failClosed(
          restoreDeclarations,
          stopErrors,
          "Installation change could not cleanly stop the affected Instances",
        );
      }

      try {
        await this.#activateInstallations(nextPlan, affected, nextConfigs, contracts);
        contracts.commit();
        this.#activationOrder = nextPlan.order.slice();
        this.#plan = nextPlan;
        return Object.freeze({ kind: "committed", affected });
      } catch (changeError) {
        const nextStopErrors = await this.#deactivateInstallations(affected);
        contracts.discard();
        if (changeError instanceof IncompleteActivationCleanupError || nextStopErrors.length) {
          return this.#failClosed(
            restoreDeclarations,
            [changeError, ...nextStopErrors],
            "Installation change failed and its partial activation could not be cleanly disposed",
          );
        }
        return this.#rollback(restoreDeclarations, previousPlan, affected, previousConfigs, [
          changeError,
          ...nextStopErrors,
        ]);
      }
    });
  }

  async #activateInitialPlan(plan: InstallationGraph, contracts: ContractRegistryDraft) {
    const installations = new Set(plan.order);
    const configs = await this.#resolveConfigs(plan.order);
    this.#services.clear();
    this.#activationOrder = [];
    try {
      await this.#activateInstallations(plan, installations, configs, contracts);
      contracts.commit();
      this.#activationOrder = plan.order.slice();
    } catch (error) {
      const cleanupErrors = await this.#deactivateInstallations(installations);
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Host startup failed");
      }
      throw error;
    }
  }

  async #failClosed(
    restoreDeclarations: () => void,
    causes: ReadonlyArray<unknown>,
    message: string,
  ): Promise<never> {
    restoreDeclarations();
    const shutdownErrors = await this.#deactivateInstallations(new Set(this.#activationOrder));
    this.#plan = undefined;
    throw new AggregateError([...causes, ...shutdownErrors], message);
  }

  async #rollback(
    restoreDeclarations: () => void,
    previousPlan: InstallationGraph,
    affected: ReadonlySet<InstallationRecord>,
    previousConfigs: ReadonlyMap<InstallationRecord, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<TransitionOutcome> {
    restoreDeclarations();
    const contracts = this.#contracts.draft(previousPlan.contractKinds);
    try {
      await this.#activateInstallations(previousPlan, affected, previousConfigs, contracts);
      contracts.commit();
      this.#activationOrder = previousPlan.order.slice();
      this.#plan = previousPlan;
    } catch (rollbackError) {
      const shutdownErrors = await this.#deactivateInstallations(new Set(this.#activationOrder));
      contracts.discard();
      this.#plan = undefined;
      throw new AggregateError(
        [...causes, rollbackError, ...shutdownErrors],
        "Installation change failed and the previous Instances could not be restored",
      );
    }
    const error =
      causes.length === 1 ? causes[0] : new AggregateError(causes, "Installation change failed");
    return Object.freeze({ kind: "rolled-back", affected, error });
  }

  async #activateInstallations(
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
              : await this.#resolveConfig(
                  installation.declaration.plugin.config,
                  installation.declaration.config,
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

  async #deactivateInstallations(installations: ReadonlySet<InstallationRecord>) {
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

  async #resolveConfigs(installations: ReadonlyArray<InstallationRecord>) {
    const configs = new Map<InstallationRecord, unknown>();
    for (const installation of installations) {
      try {
        configs.set(
          installation,
          await this.#resolveConfig(
            installation.declaration.plugin.config,
            installation.declaration.config,
          ),
        );
      } catch (error) {
        throw normalizeFailure(
          error,
          "INSTALLATION_UNAVAILABLE",
          `Installation '${installation.id}' failed with a non-Error value`,
        );
      }
    }
    return configs;
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

  async #resolveConfig(schema: StandardSchemaV1<unknown, unknown> | undefined, config: unknown) {
    if (!schema) return config;
    const result = await schema["~standard"].validate(config);
    if (result.issues) {
      throw new ConfigValidationError(
        result.issues.map((issue) => ({
          message: issue.message,
          ...(issue.path ? { path: issue.path } : {}),
        })) as ValidationIssue[],
      );
    }
    return result.value;
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

  async #withContributionBatch<T>(operation: () => Promise<T>) {
    this.#contributions.beginBatch();
    try {
      return await operation();
    } finally {
      this.#contributions.endBatch();
    }
  }

  #requirePlan() {
    if (!this.#plan) {
      throw hostServicesUnavailable();
    }
    return this.#plan;
  }
}

function hostServicesUnavailable() {
  return new DougongError("SERVICE_UNAVAILABLE", "Host services are not active");
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
