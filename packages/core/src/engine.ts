import { resolvePluginConfig } from "./configuration";
import { ContractRegistry, type ContractRegistryWriter } from "./contract-registry";
import {
  normalizeContract,
  normalizeRequirement,
  type ExtensionPoint,
  type OptionalService,
  type Service,
} from "./contracts";
import { DougongError, normalizeFailure } from "./errors";
import { InstallationGraph } from "./installation-graph";
import type { InstallationDeclaration, InstallationRecord } from "./installation";
import {
  type ActivationFailure,
  InstanceCoordinator,
  type InstanceCoordinatorPort,
} from "./instance-coordinator";

/** Every execution terminal outcome carries the records whose readiness must settle. */
export type TransitionOutcome =
  | { readonly kind: "committed"; readonly affected: ReadonlySet<InstallationRecord> }
  | {
      readonly kind: "rolled-back" | "failed-closed";
      readonly affected: ReadonlySet<InstallationRecord>;
      readonly error: unknown;
    };

type ServiceAvailability = "available" | "unavailable";

/**
 * Owns the committed plan and its commit, rollback and fail-closed transitions.
 *
 * `#plan` is the single definition of "committed". It is assigned only after an
 * activation succeeds and cleared whenever no consistent graph exists, so
 * `hasCommittedPlan` is the honest answer to whether this Host can serve reads —
 * there is no second flag that could disagree with it.
 */
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
    const normalized = normalizeRequirement(requirement, "Expected a Service");
    if (normalized.kind === "extensionPoint") throw new TypeError("Expected a Service");
    const allowMissing = normalized.kind === "optional";
    const token = normalized.kind === "optional" ? normalized.service : normalized;
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
    const identity = normalizeContract(token, "extensionPoint");
    this.#contracts.remember(identity);
    return this.#instances.contributions(identity);
  }

  buildPlan(declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>) {
    return InstallationGraph.build(declarations, this.#contracts.kinds);
  }

  async start(plan: InstallationGraph) {
    const contracts = this.#contracts.writer(plan.contractKinds);
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

  /**
   * The whole transaction, in the order the steps have to happen.
   *
   * Configs resolve and Contract identities draft *before* anything stops,
   * because those are the failures that can still be taken back for free — a
   * schema rejection at this point costs nothing. Once the affected Instances
   * are down, every remaining failure has a price, and the only question left is
   * whether the previous state can be restored.
   *
   * The whole body runs inside one contribution batch, so contributions
   * withdrawn by stopping Instances and added by starting ones become visible in
   * a single step. Without it, an ExtensionPoint observer would see the set
   * briefly empty in the middle of a successful change.
   */
  async transition(
    nextPlan: InstallationGraph,
    changed: ReadonlySet<InstallationRecord>,
    commitDeclarations: () => void,
  ): Promise<TransitionOutcome> {
    return this.#instances.withContributionBatch(async () => {
      const previousPlan = this.#requirePlan();
      // Dependents are affected too, in both plans: a Service being replaced
      // takes down whatever consumed it, and whatever will consume it next.
      const affected = previousPlan.affectedByTransitionTo(nextPlan, changed);
      const nextConfigs = await this.#resolveConfigs(
        nextPlan,
        nextPlan.order.filter((installation) => affected.has(installation)),
      );
      const contracts = this.#contracts.writer(nextPlan.contractKinds);

      const previousConfigs = this.#instances.captureConfigs(affected);
      const stopErrors = await this.#instances.deactivate(affected);
      if (stopErrors.length) {
        contracts.discard();
        return this.#failClosed(
          new Set([...previousPlan.order, ...affected]),
          stopErrors,
          "Installation change could not cleanly stop the affected Instances",
        );
      }

      let activationFailure: ActivationFailure | undefined;
      try {
        activationFailure = await this.#instances.activate(
          nextPlan,
          affected,
          nextConfigs,
          contracts,
        );
        if (activationFailure) throw activationFailure.error;
        contracts.commit();
        this.#instances.commitActivationOrder(nextPlan.order);
        this.#plan = nextPlan;
        commitDeclarations();
        return Object.freeze({ kind: "committed", affected });
      } catch (changeError) {
        const nextStopErrors = await this.#instances.deactivate(affected);
        contracts.discard();
        // Rollback is only attempted when the failed activation left nothing
        // behind. If cleanup was incomplete, some Instance from the abandoned
        // plan may still hold a resource, so restoring the previous one would
        // run two owners of the same thing at once — fail closed instead.
        if (activationFailure?.cleanupIncomplete || nextStopErrors.length) {
          return this.#failClosed(
            new Set([...previousPlan.order, ...affected]),
            [changeError, ...nextStopErrors],
            "Installation change failed and its partial activation could not be cleanly disposed",
          );
        }
        return this.#rollback(previousPlan, affected, previousConfigs, [
          changeError,
          ...nextStopErrors,
        ]);
      }
    });
  }

  async #activateInitialPlan(plan: InstallationGraph, contracts: ContractRegistryWriter) {
    const installations = new Set(plan.order);
    const configs = await this.#resolveConfigs(plan, plan.order);
    this.#instances.resetActivationState();
    try {
      const failure = await this.#instances.activate(plan, installations, configs, contracts);
      if (failure) throw failure.error;
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

  /**
   * The last level: no consistent graph could be reached, so none is presented.
   *
   * Everything stops and `#plan` is cleared, which drops the Host to `idle` and
   * closes reads. The AggregateError carries every cause — the original failure
   * first, then whatever shutdown itself hit. Nothing is swallowed here; the
   * point of failing closed is that the report is complete.
   */
  async #failClosed(
    affected: ReadonlySet<InstallationRecord>,
    causes: ReadonlyArray<unknown>,
    message: string,
  ): Promise<TransitionOutcome> {
    const shutdownErrors = await this.#instances.deactivateAll();
    this.#plan = undefined;
    return {
      kind: "failed-closed",
      affected,
      error: new AggregateError([...causes, ...shutdownErrors], message),
    };
  }

  /**
   * Restores the previous plan using the configs captured before the change, not
   * mutable records. Declaration versions belong to the plan; re-validating
   * configs could fail for a second,
   * unrelated reason while trying to recover from the first.
   *
   * A rollback that itself fails returns a fail-closed outcome for the entire graph.
   */
  async #rollback(
    previousPlan: InstallationGraph,
    affected: ReadonlySet<InstallationRecord>,
    previousConfigs: ReadonlyMap<InstallationRecord, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<TransitionOutcome> {
    const contracts = this.#contracts.writer(previousPlan.contractKinds);
    try {
      const failure = await this.#instances.activate(
        previousPlan,
        affected,
        previousConfigs,
        contracts,
      );
      if (failure) throw failure.error;
      contracts.commit();
      this.#instances.commitActivationOrder(previousPlan.order);
      this.#plan = previousPlan;
    } catch (rollbackError) {
      contracts.discard();
      return this.#failClosed(
        new Set([...previousPlan.order, ...affected]),
        [...causes, rollbackError],
        "Installation change failed and the previous Instances could not be restored",
      );
    }
    const error =
      causes.length === 1 ? causes[0] : new AggregateError(causes, "Installation change failed");
    return Object.freeze({ kind: "rolled-back", affected, error });
  }

  async #resolveConfigs(plan: InstallationGraph, installations: ReadonlyArray<InstallationRecord>) {
    const configs = new Map<InstallationRecord, unknown>();
    for (const installation of installations) {
      try {
        const declaration = plan.declarationFor(installation);
        const resolved = await resolvePluginConfig(
          declaration.plugin.config,
          declaration.config,
          installation.id,
        );
        configs.set(installation, resolved.value);
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
