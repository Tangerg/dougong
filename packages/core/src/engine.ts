import { resolvePluginConfig } from "./configuration";
import { ContractRegistry, type ContractRegistryDraft } from "./contract-registry";
import {
  assertContract,
  isOptionalService,
  type ExtensionPoint,
  type OptionalService,
  type Service,
} from "./contracts";
import { DougongError, normalizeFailure } from "./errors";
import { InstallationGraph } from "./installation-graph";
import type { InstallationRecord } from "./installation";
import {
  IncompleteActivationCleanupError,
  InstanceCoordinator,
  type InstanceCoordinatorPort,
} from "./instance-coordinator";

export type TransitionOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<InstallationRecord> }
  | {
      readonly kind: "rolled-back";
      readonly affected: ReadonlySet<InstallationRecord>;
      readonly error: unknown;
    };

type ServiceAvailability = "available" | "unavailable";

/** Owns the committed plan and its commit, rollback and fail-closed transitions. */
export class Engine {
  readonly #contracts = new ContractRegistry();
  readonly #instances: InstanceCoordinator;
  #plan: InstallationGraph | undefined;

  constructor(port: InstanceCoordinatorPort) {
    this.#instances = new InstanceCoordinator(port);
  }

  get hasCommittedPlan() {
    return this.#plan !== undefined;
  }

  get<T>(
    requirement: Service<T> | OptionalService<T>,
    availability: ServiceAvailability,
  ): T | undefined {
    const allowMissing = isOptionalService(requirement);
    const token = allowMissing ? requirement.service : requirement;
    assertContract(token, "service");
    this.#contracts.assertCompatible(token);
    if (availability === "unavailable") throw hostServicesUnavailable();

    const provider = this.#requirePlan().provider(token.id);
    if (!provider) {
      if (allowMissing) return undefined;
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    const service = this.#instances.readService(provider, token.id);
    if (!service.found) {
      if (allowMissing) return undefined;
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    return service.value as T;
  }

  contributions<T>(token: ExtensionPoint<T>) {
    assertContract(token, "extensionPoint");
    this.#contracts.remember(token);
    return this.#instances.contributions(token);
  }

  buildPlan(installations: Iterable<InstallationRecord>) {
    return InstallationGraph.build(installations, this.#contracts.kinds);
  }

  async start(plan: InstallationGraph) {
    const contracts = this.#contracts.draft(plan.contractKinds);
    try {
      await this.#instances.withContributionBatch(() => this.#activateInitialPlan(plan, contracts));
      this.#plan = plan;
    } catch (error) {
      contracts.discard();
      this.#plan = undefined;
      throw error;
    }
  }

  async stop() {
    const errors = await this.#instances.withContributionBatch(() =>
      this.#instances.deactivateAll(),
    );
    this.#plan = undefined;
    return errors;
  }

  async transition(
    nextPlan: InstallationGraph,
    changed: ReadonlySet<InstallationRecord>,
    restoreDeclarations: () => void,
  ): Promise<TransitionOutcome> {
    return this.#instances.withContributionBatch(async () => {
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

      const previousConfigs = this.#instances.captureConfigs(affected);
      const stopErrors = await this.#instances.deactivate(affected);
      if (stopErrors.length) {
        contracts.discard();
        return this.#failClosed(
          restoreDeclarations,
          stopErrors,
          "Installation change could not cleanly stop the affected Instances",
        );
      }

      try {
        await this.#instances.activate(nextPlan, affected, nextConfigs, contracts);
        contracts.commit();
        this.#instances.commitActivationOrder(nextPlan.order);
        this.#plan = nextPlan;
        return Object.freeze({ kind: "committed", affected });
      } catch (changeError) {
        const nextStopErrors = await this.#instances.deactivate(affected);
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
    this.#instances.resetActivationState();
    try {
      await this.#instances.activate(plan, installations, configs, contracts);
      contracts.commit();
      this.#instances.commitActivationOrder(plan.order);
    } catch (error) {
      const cleanupErrors = await this.#instances.deactivate(installations);
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
    const shutdownErrors = await this.#instances.deactivateAll();
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
      await this.#instances.activate(previousPlan, affected, previousConfigs, contracts);
      contracts.commit();
      this.#instances.commitActivationOrder(previousPlan.order);
      this.#plan = previousPlan;
    } catch (rollbackError) {
      const shutdownErrors = await this.#instances.deactivateAll();
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

  async #resolveConfigs(installations: ReadonlyArray<InstallationRecord>) {
    const configs = new Map<InstallationRecord, unknown>();
    for (const installation of installations) {
      try {
        configs.set(
          installation,
          await resolvePluginConfig(
            installation.declaration.plugin.config,
            installation.declaration.config,
            installation.id,
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

  #requirePlan() {
    if (!this.#plan) throw hostServicesUnavailable();
    return this.#plan;
  }
}

function hostServicesUnavailable() {
  return new DougongError("SERVICE_UNAVAILABLE", "Host services are not active");
}
