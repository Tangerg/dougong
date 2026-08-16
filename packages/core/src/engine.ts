import { resolvePluginConfig } from "./configuration";
import { ContractRegistry, type ContractRegistryDraft } from "./contract-registry";
import { assertContract, type Service } from "./contracts";
import { DougongError, normalizeFailure } from "./errors";
import { InstallationGraph } from "./installation-graph";
import type { InstallationRecord } from "./installation";
import type { Logger } from "./lifetime";
import { IncompleteActivationCleanupError, Runtime } from "./runtime";

export type TransitionOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<InstallationRecord> }
  | {
      readonly kind: "rolled-back";
      readonly affected: ReadonlySet<InstallationRecord>;
      readonly error: unknown;
    };

interface EngineOptions {
  readonly hostName: string;
  readonly logger: Logger;
  readonly isInstalled: (installationId: string) => boolean;
  readonly report: (error: unknown) => void;
}

type ServiceAvailability = "available" | "unavailable";

/** Owns the committed plan and its commit, rollback and fail-closed transitions. */
export class Engine {
  readonly #contracts = new ContractRegistry();
  readonly #runtime: Runtime;
  #plan: InstallationGraph | undefined;

  constructor(options: EngineOptions) {
    this.#runtime = new Runtime(options);
  }

  get hasCommittedPlan() {
    return this.#plan !== undefined;
  }

  get<T>(token: Service<T>, availability: ServiceAvailability): T {
    assertContract(token, "service");
    this.#contracts.assertCompatible(token);
    if (availability === "unavailable") throw hostServicesUnavailable();

    const provider = this.#requirePlan().provider(token.id);
    if (!provider) {
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    const service = this.#runtime.readService(provider, token.id);
    if (!service.found) {
      throw new DougongError("SERVICE_UNAVAILABLE", `Service '${token.id}' is not active`);
    }
    return service.value as T;
  }

  buildPlan(installations: Iterable<InstallationRecord>) {
    return InstallationGraph.build(installations, this.#contracts.kinds);
  }

  async start(plan: InstallationGraph) {
    const contracts = this.#contracts.draft(plan.contractKinds);
    try {
      await this.#runtime.withContributionBatch(() => this.#activateInitialPlan(plan, contracts));
      this.#plan = plan;
    } catch (error) {
      contracts.discard();
      this.#plan = undefined;
      throw error;
    }
  }

  async stop() {
    const errors = await this.#runtime.withContributionBatch(() => this.#runtime.deactivateAll());
    this.#plan = undefined;
    return errors;
  }

  async transition(
    nextPlan: InstallationGraph,
    changed: ReadonlySet<InstallationRecord>,
    restoreDeclarations: () => void,
  ): Promise<TransitionOutcome> {
    return this.#runtime.withContributionBatch(async () => {
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

      const previousConfigs = this.#runtime.captureConfigs(affected);
      const stopErrors = await this.#runtime.deactivate(affected);
      if (stopErrors.length) {
        contracts.discard();
        return this.#failClosed(
          restoreDeclarations,
          stopErrors,
          "Installation change could not cleanly stop the affected Instances",
        );
      }

      try {
        await this.#runtime.activate(nextPlan, affected, nextConfigs, contracts);
        contracts.commit();
        this.#runtime.commitActivationOrder(nextPlan.order);
        this.#plan = nextPlan;
        return Object.freeze({ kind: "committed", affected });
      } catch (changeError) {
        const nextStopErrors = await this.#runtime.deactivate(affected);
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
    this.#runtime.resetActivationState();
    try {
      await this.#runtime.activate(plan, installations, configs, contracts);
      contracts.commit();
      this.#runtime.commitActivationOrder(plan.order);
    } catch (error) {
      const cleanupErrors = await this.#runtime.deactivate(installations);
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
    const shutdownErrors = await this.#runtime.deactivateAll();
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
      await this.#runtime.activate(previousPlan, affected, previousConfigs, contracts);
      contracts.commit();
      this.#runtime.commitActivationOrder(previousPlan.order);
      this.#plan = previousPlan;
    } catch (rollbackError) {
      const shutdownErrors = await this.#runtime.deactivateAll();
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
