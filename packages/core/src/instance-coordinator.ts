import type { ContractRegistryWriter } from "./contract-registry";
import { assertContract, type Event, type ExtensionPoint, type Requirement } from "./contracts";
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

type ExtensionPointIdentity = Extract<Requirement, { readonly kind: "extensionPoint" }>;

export interface InstanceCoordinatorPort {
  readonly hostName: string;
  readonly logger: Logger;
  readonly report: (error: unknown) => void;
}

/** Every activation aggregation must preserve this classification before returning to Engine. */
export class IncompleteActivationCleanupError extends AggregateError {}

/**
 * Owns live Instances and the capabilities reachable from their Lifetimes.
 *
 * The only place in Core where `setup()` is called and where a Service value
 * exists as a value. Above this line everything is declarations and plans; below
 * it there are running objects.
 *
 * Activation is prepare-then-commit, per layer. Every Instance in a layer is
 * built first, and only once the whole layer succeeds does any of it become
 * visible. That is why a failing sibling cannot be observed by one that
 * succeeded, and why cleanup after a failed layer can still reach everything the
 * layer created.
 */
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
  ) {
    const port = this.#createLifetimePort(contracts);
    for (const layer of plan.layers) {
      const candidates = layer.filter(
        (installation) => installations.has(installation) && !installation.instance,
      );
      if (!candidates.length) continue;

      // One controller per layer, aborted by the first failure. Siblings run
      // concurrently, so a long `setup()` next to one that failed immediately
      // would otherwise keep the whole layer waiting for work whose result is
      // already going to be thrown away. `allSettled` rather than `all` because
      // every started Instance must be collected for cleanup, including the ones
      // that finished after the abort.
      const controller = new AbortController();
      const results = await Promise.allSettled(
        candidates.map(async (installation) => {
          try {
            if (!configs.has(installation)) {
              throw new Error(`Installation '${installation.id}' has no prepared config`);
            }
            const config = configs.get(installation);
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
        if (
          cleanupErrors.length ||
          errors.some((error) => error instanceof IncompleteActivationCleanupError)
        ) {
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

  /**
   * Stops in reverse activation order, sequentially, and collects every failure
   * instead of stopping at the first. A dependent must be gone before the
   * Service it consumed, and one Instance that refuses to shut down cleanly must
   * not leave the rest running — its error is returned, not thrown.
   */
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

  /**
   * Runs one operation with contribution publication deferred to its end, so a
   * change that withdraws and adds contributions is observed once rather than as
   * an intermediate state.
   *
   * Publication happens even when the operation failed, because contributions
   * withdrawn by Instances that did stop must not stay visible. If both the
   * operation and the publication fail, both errors are reported — the
   * publication failure must not hide the reason the change failed, and the
   * operation failure must not hide a store left inconsistent.
   */
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
      // The types already require these, but `setup()` may come from JavaScript
      // or from a Plugin loaded at runtime, where nothing checked them. A missing
      // Service has to fail here rather than surface later as an `undefined`
      // dependency inside whatever consumed it.
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
        instance: Object.freeze({ plugin, config, lifetime }),
        services,
      });
    } catch (error) {
      const failure = installation.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        // A failed `setup()` may have already registered listeners, tasks or
        // cleanups. If disposing them also fails, this Installation is not
        // merely broken — something it created is still alive and unowned. The
        // distinct error type is what tells the Engine that rollback is unsafe.
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
    plugin: NormalizedPlugin,
    lifetime: Lifetime,
  ): Record<string, unknown> {
    // Requirements resolve through `plan.providerFor`, the edge recorded when the
    // graph was built — not by searching for whoever currently provides the id.
    // The dependency a Plugin was validated against is the one it receives.
    //
    // A null prototype because these keys come from the declaration: an alias
    // called `toString` must be a requirement, not an inherited method.
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
    assertContract(token, "event");
    contracts.remember(token);
    return this.#events.stage(token.id, listener, release);
  }

  #emit<T>(token: Event<T>, payload: T, contracts: ContractRegistryWriter) {
    assertContract(token, "event");
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
    assertContract(token, "extensionPoint");
    contracts.remember(token);
    return this.#contributions.get<T>(token).stage(installationId, key, value, release);
  }

  #contributionView(token: ExtensionPointIdentity, lifetime: Lifetime): ContributionView<unknown> {
    return this.#contributions
      .get(token)
      .view((resource, kind) => lifetime.ownLease(resource, kind));
  }
}

// Separates real failures from the cancellations they caused.
//
// When one Instance in a layer fails, the shared controller aborts and every
// sibling rejects with that same reason. Reporting all of them would turn one
// root cause into N identical errors, so the root is kept once and the derived
// cancellations are dropped. A sibling that failed for its own reason is still
// reported — two genuine failures in one layer are two errors.
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
