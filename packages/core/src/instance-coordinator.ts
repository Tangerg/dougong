import type { ContractRegistryWriter } from "./contract-registry";
import type { Event, ExtensionPoint, Requirement } from "./contracts";
import { ContributionRegistry, type ContributionView } from "./contribution-store";
import { DougongError, isCancellationReason } from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import type { InstallationGraph } from "./installation-graph";
import type { InstallationRecord, Instance } from "./installation";
import { Lifetime, type InstanceMeta, type LifetimePort, type Logger } from "./lifetime";
import type { InstanceContext, NormalizedPlugin } from "./plugin";
import type { Publication } from "./resource";
import { assertSynchronous } from "./sync-result";

interface PreparedActivation {
  readonly installation: InstallationRecord;
  readonly instance: Instance;
  readonly services: ReadonlyMap<string, unknown>;
}

// Only this internal outcome carries cleanup authority; public errors must not.
export class ActivationFailure {
  constructor(
    readonly error: unknown,
    readonly cancelled: boolean,
    readonly cleanupIncomplete = false,
  ) {
    Object.freeze(this);
  }
}

type ExtensionPointIdentity = Extract<Requirement, { readonly kind: "extensionPoint" }>;

export interface InstanceCoordinatorPort {
  readonly hostName: string;
  readonly logger: Logger;
  readonly report: (error: unknown) => void;
}

export class InstanceCoordinator {
  readonly #hostName: string;
  readonly #logger: Logger;
  readonly #report: (error: unknown) => void;
  readonly #services = new Map<InstallationRecord, ReadonlyMap<string, unknown>>();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;
  #activationOrder: InstallationRecord[] = [];

  constructor(port: InstanceCoordinatorPort) {
    this.#hostName = port.hostName;
    this.#logger = port.logger;
    this.#report = port.report;
    this.#contributions = new ContributionRegistry(port.report);
  }

  readService(provider: InstallationRecord, serviceId: string) {
    const services = this.#services.get(provider);
    return services?.has(serviceId)
      ? { found: true as const, value: services.get(serviceId) }
      : { found: false as const };
  }

  contributions<T>(token: ExtensionPoint<T>) {
    return this.#contributions.view<T>(token);
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
    contracts: ContractRegistryWriter,
  ): Promise<ActivationFailure | undefined> {
    const port = this.#createLifetimePort(contracts);
    for (const layer of plan.layers) {
      const candidates = layer.filter(
        (installation) => installations.has(installation) && !installation.instance,
      );
      if (!candidates.length) continue;

      // Fix each failure attribution before shared cancellation can change a sibling signal.
      const controller = new AbortController();
      const results = await Promise.all(
        candidates.map(async (installation) => {
          try {
            if (!configs.has(installation)) {
              throw new Error(`Installation '${installation.id}' has no prepared config`);
            }
            const config = configs.get(installation);
            const result = await this.#prepareActivation(
              plan,
              installation,
              config,
              controller.signal,
              port,
            );
            if (result instanceof ActivationFailure) controller.abort(result.error);
            return result;
          } catch (error) {
            const failure = new ActivationFailure(
              error,
              isCancellationReason(controller.signal, error),
            );
            controller.abort(error);
            return failure;
          }
        }),
      );

      const errors = results.flatMap((result) =>
        result instanceof ActivationFailure && !result.cancelled ? [result.error] : [],
      );
      const prepared = results.filter(
        (result): result is PreparedActivation => !(result instanceof ActivationFailure),
      );

      if (errors.length) {
        const cleanupErrors = await this.#disposePreparedActivations(prepared);
        const startupError =
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Installation startup layer failed");
        if (
          cleanupErrors.length ||
          results.some((result) => result instanceof ActivationFailure && result.cleanupIncomplete)
        ) {
          return new ActivationFailure(
            new AggregateError(
              [startupError, ...cleanupErrors],
              "Installation startup layer failed and could not be cleanly disposed",
            ),
            false,
            true,
          );
        }
        return new ActivationFailure(startupError, false);
      }

      this.#commitActivations(prepared);
    }
    return undefined;
  }

  // Dependents must stop before providers; one cleanup failure must not strand the remaining Instances.
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

  // Publish withdrawals even after failure, and retain both operation and publication errors.
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
  ): Promise<PreparedActivation | ActivationFailure> {
    installation.deactivate();
    const plugin = plan.declarationFor(installation).plugin;
    const lifetime = new Lifetime(port, installation.id, { parentSignal: startupSignal });

    try {
      const requirements = this.#resolveRequirements(plan, installation, plugin, lifetime);
      const meta: InstanceMeta = Object.freeze({
        hostName: this.#hostName,
        pluginName: plugin.name,
        installationId: installation.id,
        groupId: installation.groupId,
      });
      const context = this.#createContext(lifetime, meta, requirements);
      const output = await plugin.setup(context, config);
      const services = new Map<string, unknown>();
      // Loaded JavaScript can bypass static checks; missing Services must fail before publication.
      for (const [alias, token] of Object.entries(plugin.provides)) {
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
        // Diagnostics must remain readable after the live Lifetime binding is released.
        instance: Object.freeze({ plugin, config, lifetime, diagnostics: lifetime.diagnostics }),
        services,
      });
    } catch (error) {
      const cancelled = isCancellationReason(lifetime.signal, error);
      const failure = installation.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        // A failed setup may own resources; failed cleanup must prevent rollback over those resources.
        return new ActivationFailure(
          new AggregateError(
            [failure, cleanupError],
            `Installation '${installation.id}' failed to start and could not be cleanly disposed`,
          ),
          false,
          true,
        );
      }
      return new ActivationFailure(failure, cancelled);
    }
  }

  #commitActivations(candidates: ReadonlyArray<PreparedActivation>) {
    // Own the complete layer before publication so invariant failure can still unwind every Instance.
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
    plugin: NormalizedPlugin,
    lifetime: Lifetime,
  ): Record<string, unknown> {
    // Resolve against captured plan edges so dependency identity cannot drift during activation.
    const values: Record<string, unknown> = Object.create(null);
    for (const [alias, requirement] of Object.entries(plugin.requires)) {
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
  ): InstanceContext {
    return Object.freeze({
      ...requirements,
      get signal() {
        return lifetime.signal;
      },
      meta,
      log: lifetime.contextLogger(meta),
      cleanup: lifetime.cleanup.bind(lifetime),
      lifetime: lifetime.lifetime.bind(lifetime),
      spawn: lifetime.spawn.bind(lifetime),
      on: lifetime.on.bind(lifetime),
      emit: lifetime.emit.bind(lifetime),
      contribute: lifetime.contribute.bind(lifetime),
    });
  }

  #createLifetimePort(contracts: ContractRegistryWriter): LifetimePort {
    return {
      stageOn: (token, listener, release) => {
        return this.#stageOn(token, listener, release, contracts);
      },
      emit: (token, payload) => this.#emit(token, payload, contracts),
      stageContribution: (installationId, token, key, value, release) => {
        return this.#stageContribution(installationId, token, key, value, release, contracts);
      },
      writeLog: (level, message, meta, details) => {
        assertSynchronous(
          this.#logger[level](message, meta, ...details),
          "Logger methods must be synchronous",
        );
      },
      report: this.#report,
    };
  }

  #stageOn<T>(
    token: Event<T>,
    listener: EventListener<T>,
    release: (publication: Publication) => void,
    contracts: ContractRegistryWriter,
  ) {
    contracts.remember(token);
    return this.#events.stage(token.id, listener, release);
  }

  #emit<T>(token: Event<T>, payload: T, contracts: ContractRegistryWriter) {
    contracts.remember(token);
    return this.#events.emit(token.id, payload);
  }

  #stageContribution<T>(
    installationId: string,
    token: ExtensionPoint<T>,
    key: string,
    value: T,
    release: (publication: Publication) => void,
    contracts: ContractRegistryWriter,
  ) {
    contracts.remember(token);
    return this.#contributions.get<T>(token).stage(installationId, key, value, release);
  }

  #contributionView(token: ExtensionPointIdentity, lifetime: Lifetime): ContributionView<unknown> {
    return this.#contributions
      .get(token)
      .view((resource, kind) => lifetime.ownLease(resource, kind));
  }
}
