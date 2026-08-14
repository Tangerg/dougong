import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ContractRegistry, type ContractRegistryDraft } from "./contract-registry";
import { assertContract, type Event, type Extension, type Service } from "./contracts";
import { ConfigValidationError, DougongError, type ValidationIssue } from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import { ExtensionRegistry, type ExtensionView } from "./extension-store";
import { Lifetime, type LifetimeHost, type Logger, type PluginMeta } from "./lifetime";
import { PluginGraph } from "./plugin-graph";
import { type AnyPlugin, type PluginInstallation, type PluginRuntime } from "./plugin-installation";
import type { PluginContext, Requirements } from "./plugin";
import type { Publication } from "./resource";

export type RuntimeChangeOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<PluginInstallation> }
  | {
      readonly kind: "rolled-back";
      readonly affected: ReadonlySet<PluginInstallation>;
      readonly error: unknown;
    };

interface PreparedActivation {
  readonly installation: PluginInstallation;
  readonly runtime: PluginRuntime;
  readonly services: ReadonlyMap<string, unknown>;
}

interface ApplicationRuntimeOptions {
  readonly applicationName: string;
  readonly logger: Logger;
  readonly isInstalled: (installationId: string) => boolean;
  readonly report: (error: unknown) => void;
}

type ServiceAvailability = "available" | "unavailable";

class IncompletePluginCleanupError extends AggregateError {}

/**
 * Owns the committed plugin runtime: contracts, services, events, extensions,
 * Lifetimes and graph transitions. The Application owns declarations and
 * command serialization; neither side duplicates the other's state.
 */
export class ApplicationRuntime {
  readonly #applicationName: string;
  readonly #logger: Logger;
  readonly #isInstalled: (installationId: string) => boolean;
  readonly #report: (error: unknown) => void;
  readonly #services = new Map<PluginInstallation, ReadonlyMap<string, unknown>>();
  readonly #contracts = new ContractRegistry();
  readonly #events = new EventHub();
  readonly #extensions: ExtensionRegistry;

  #plan: PluginGraph | undefined;
  #activationOrder: PluginInstallation[] = [];

  constructor(options: ApplicationRuntimeOptions) {
    this.#applicationName = options.applicationName;
    this.#logger = options.logger;
    this.#isInstalled = options.isInstalled;
    this.#report = options.report;
    this.#extensions = new ExtensionRegistry(options.report);
  }

  get hasCommittedPlan() {
    return this.#plan !== undefined;
  }

  get<T>(token: Service<T>, availability: ServiceAvailability): T {
    assertContract(token, "service");
    this.#contracts.assertCompatible(token);
    if (availability === "unavailable") {
      throw applicationServicesUnavailable();
    }
    const provider = this.#requirePlan().provider(token.id);
    const services = provider ? this.#services.get(provider) : undefined;
    if (!provider || !services?.has(token.id)) {
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    return services.get(token.id) as T;
  }

  buildPlan(installations: Iterable<PluginInstallation>) {
    return PluginGraph.build(installations, this.#contracts.kinds);
  }

  async start(plan: PluginGraph) {
    const contracts = this.#contracts.draft(plan.contractKinds);
    try {
      await this.#withExtensionBatch(() => this.#activateInitialPlan(plan, contracts));
      this.#plan = plan;
    } catch (error) {
      contracts.discard();
      this.#plan = undefined;
      throw error;
    }
  }

  async stop() {
    const errors = await this.#withExtensionBatch(() =>
      this.#deactivateInstallations(new Set(this.#activationOrder)),
    );
    this.#plan = undefined;
    return errors;
  }

  async transition(
    nextPlan: PluginGraph,
    changed: ReadonlySet<PluginInstallation>,
    restoreDeclarations: () => void,
  ): Promise<RuntimeChangeOutcome> {
    return this.#withExtensionBatch(async () => {
      const previousPlan = this.#requirePlan();
      const affected = previousPlan.affectedByTransitionTo(nextPlan, changed);
      let nextConfigs: ReadonlyMap<PluginInstallation, unknown>;
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

      const previousConfigs = new Map<PluginInstallation, unknown>();
      for (const installation of affected) {
        const runtime = installation.runtime;
        if (runtime) previousConfigs.set(installation, runtime.config);
      }

      const stopErrors = await this.#deactivateInstallations(affected);
      if (stopErrors.length) {
        contracts.discard();
        return this.#failClosed(
          restoreDeclarations,
          stopErrors,
          "Plugin change could not cleanly stop the affected runtime",
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
        if (changeError instanceof IncompletePluginCleanupError || nextStopErrors.length) {
          return this.#failClosed(
            restoreDeclarations,
            [changeError, ...nextStopErrors],
            "Plugin change failed and its partial runtime could not be cleanly disposed",
          );
        }
        return this.#rollback(restoreDeclarations, previousPlan, affected, previousConfigs, [
          changeError,
          ...nextStopErrors,
        ]);
      }
    });
  }

  async #activateInitialPlan(plan: PluginGraph, contracts: ContractRegistryDraft) {
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
        throw new AggregateError([error, ...cleanupErrors], "Application startup failed");
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
    previousPlan: PluginGraph,
    affected: ReadonlySet<PluginInstallation>,
    previousConfigs: ReadonlyMap<PluginInstallation, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<RuntimeChangeOutcome> {
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
        "Plugin change failed and the previous application could not be restored",
      );
    }
    const error =
      causes.length === 1 ? causes[0] : new AggregateError(causes, "Plugin change failed");
    return Object.freeze({ kind: "rolled-back", affected, error });
  }

  async #activateInstallations(
    plan: PluginGraph,
    installations: ReadonlySet<PluginInstallation>,
    configs: ReadonlyMap<PluginInstallation, unknown>,
    contracts: ContractRegistryDraft,
  ) {
    const host = this.#createLifetimeHost(contracts);
    for (const layer of plan.layers) {
      const candidates = layer.filter(
        (installation) => installations.has(installation) && !installation.runtime,
      );
      if (!candidates.length) continue;

      const controller = new AbortController();
      const results = await Promise.allSettled(
        candidates.map(async (installation) => {
          try {
            const config = configs.has(installation)
              ? configs.get(installation)
              : await this.#resolveConfig(
                  installation.spec.plugin.config,
                  installation.spec.config,
                );
            return await this.#prepareActivation(
              plan,
              installation,
              config,
              controller.signal,
              host,
            );
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        }),
      );

      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
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
            : new AggregateError(errors, "Plugin startup layer failed");
        if (cleanupErrors.length) {
          throw new IncompletePluginCleanupError(
            [startupError, ...cleanupErrors],
            "Plugin startup layer failed and could not be cleanly disposed",
          );
        }
        throw startupError;
      }

      for (const candidate of prepared) this.#commitActivation(candidate);
    }
  }

  async #prepareActivation(
    plan: PluginGraph,
    installation: PluginInstallation,
    config: unknown,
    startupSignal: AbortSignal,
    host: LifetimeHost,
  ): Promise<PreparedActivation> {
    installation.deactivate();
    const plugin = installation.spec.plugin;
    const lifetime = new Lifetime(host, installation.id, { parentSignal: startupSignal });

    try {
      const requirements = this.#resolveRequirements(plan, installation, plugin, lifetime);
      const meta: PluginMeta = {
        applicationName: this.#applicationName,
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
            `Plugin '${installation.id}' did not return provided service '${alias}'`,
          );
        }
        services.set(token.id, (output as Record<string, unknown>)[alias]);
      }

      return Object.freeze({
        installation,
        runtime: Object.freeze({ plugin, config, lifetime }),
        services,
      });
    } catch (error) {
      installation.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        throw new IncompletePluginCleanupError(
          [error, cleanupError],
          `Plugin '${installation.id}' failed to start and could not be cleanly disposed`,
        );
      }
      throw error;
    }
  }

  #commitActivation(candidate: PreparedActivation) {
    const { installation, runtime, services } = candidate;
    this.#services.set(installation, services);
    runtime.lifetime.publish();
    runtime.lifetime.detachStartupSignal();
    installation.activate(runtime);
    this.#activationOrder.push(installation);
  }

  async #disposePreparedActivations(candidates: ReadonlyArray<PreparedActivation>) {
    const errors: unknown[] = [];
    for (const candidate of [...candidates].reverse()) {
      try {
        await candidate.runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #deactivateInstallations(installations: ReadonlySet<PluginInstallation>) {
    const errors: unknown[] = [];
    const order = this.#activationOrder
      .filter((installation) => installations.has(installation))
      .reverse();
    this.#activationOrder = this.#activationOrder.filter(
      (installation) => !installations.has(installation),
    );
    for (const installation of order) {
      const runtime = installation.runtime;
      if (!runtime) continue;
      installation.beginStopping();
      this.#services.delete(installation);
      try {
        await runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        installation.deactivate();
      }
    }
    return errors;
  }

  async #resolveConfigs(installations: ReadonlyArray<PluginInstallation>) {
    const configs = new Map<PluginInstallation, unknown>();
    for (const installation of installations) {
      configs.set(
        installation,
        await this.#resolveConfig(installation.spec.plugin.config, installation.spec.config),
      );
    }
    return configs;
  }

  #resolveRequirements(
    plan: PluginGraph,
    installation: PluginInstallation,
    plugin: AnyPlugin,
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
            `Optional service '${requirement.service.id}' is not active for plugin '${installation.id}'`,
          );
        }
        values[alias] = services.get(requirement.service.id);
      } else if (requirement.kind === "service") {
        const provider = plan.providerFor(installation, requirement.id);
        const services = provider ? this.#services.get(provider) : undefined;
        if (!provider || !services?.has(requirement.id)) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Service '${requirement.id}' is not active for plugin '${installation.id}'`,
          );
        }
        values[alias] = services.get(requirement.id);
      } else {
        values[alias] = this.#extensionView(requirement, lifetime);
      }
    }
    return values;
  }

  #createContext(
    lifetime: Lifetime,
    meta: PluginMeta,
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

  #createLifetimeHost(contracts: ContractRegistryDraft): LifetimeHost {
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
    token: Extension<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
    contracts: ContractRegistryDraft,
  ) {
    this.#assertOwner(ownerId);
    assertContract(token, "extension");
    contracts.remember(token);
    return this.#extensions.get(token).stage(ownerId, key, value, release);
  }

  #extensionView<T>(token: Extension<T>, lifetime: Lifetime): ExtensionView<T> {
    return this.#extensions.get(token).view((resource, kind) => lifetime.ownLease(resource, kind));
  }

  #assertOwner(ownerId: string) {
    if (!this.#isInstalled(ownerId)) throw new TypeError(`Plugin '${ownerId}' is not installed`);
  }

  async #withExtensionBatch<T>(operation: () => Promise<T>) {
    this.#extensions.beginBatch();
    try {
      return await operation();
    } finally {
      this.#extensions.endBatch();
    }
  }

  #requirePlan() {
    if (!this.#plan) {
      throw applicationServicesUnavailable();
    }
    return this.#plan;
  }
}

function applicationServicesUnavailable() {
  return new DougongError("SERVICE_UNAVAILABLE", "Application services are not active");
}
