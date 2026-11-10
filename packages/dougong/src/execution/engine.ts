import { ContractRegistry, type ContractRegistryWriter } from "../contracts/contract-registry.js";
import {
  DougongError,
  isCancellationReason,
  quarantinedHost,
  hostBusyCode,
  hostQuarantinedCode,
  serviceUnavailableCode,
  transitionFailedCode,
} from "../contracts/errors.js";
import { RecordedFailure } from "../contracts/recorded-failure.js";
import {
  normalizeContract,
  normalizeRequirement,
  requiredContract,
  type ExtensionPoint,
  type OptionalService,
  type Service,
} from "../contracts/contracts.js";
import type { Logger } from "../contracts/logging.js";
import { disposeSymbol, type Awaitable, type ResourceAuthority } from "../contracts/resource.js";
import { EventHub } from "../events/event-hub.js";
import { ContributionRegistry } from "../contributions/contribution-registry.js";
import { SnapshotPublisher, batchSnapshotNotifications } from "../observation/snapshot-view.js";
import { onAbort } from "../internal/abort.js";
import { SerialQueue } from "../internal/serial-queue.js";
import { combineFailures } from "../internal/failures.js";
import { resolveValue, type ResolvedValue } from "../internal/async-result.js";
import type { ReleaseFailure } from "../lifetime/lifetime.js";
import { ChangeSets, type ChangeOperation } from "../composition/change-set.js";
import { HostIdentities } from "../composition/identities.js";
import type { InstallationRecord } from "../composition/installation.js";
import { InstallationGraph } from "../composition/installation-graph.js";
import { compileTransition } from "../composition/planner.js";
import {
  PlanAuthority,
  stalePlan,
  type Plan,
  type PreparedTransition,
} from "../composition/plan.js";
import type {
  ChangeSet,
  Group,
  Installation,
  InstallationState,
} from "../composition/declarations.js";
import type { HostSnapshot, HostStatus } from "../inspection/diagnostics.js";
import type { ApplyResult, HostOptions } from "./host-api.js";
import type { CommittedState, NextCommittedState } from "./committed-state.js";
import { captureHostOptions } from "./host-options.js";
import { installationExecution, projectHostSnapshot } from "./host-snapshot.js";
import { Instance } from "./instance.js";
import { Retirements, type ExecutionScope } from "./retirements.js";
import { ExecutionTransition } from "./transition.js";

type FailurePhase = "stop" | "prepare" | "restore" | "publish" | "release";

const quarantineFailureMessage = "Execution could not establish a healthy state";

// Failures inside one preparation attempt are returned together; later ones go to the reporter.
class PreparationFailures {
  #pending: unknown[] | undefined = [];
  readonly #report: (error: unknown) => void;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  add(error: unknown) {
    if (this.#pending) this.#pending.push(error);
    else this.#report(error);
  }

  seal(fallback?: unknown): unknown {
    const failures = this.#pending;
    this.#pending = undefined;
    if (!failures?.length) return fallback;
    return combineFailures(failures, "Plugin preparation failed");
  }
}

export class Engine {
  readonly name: string;
  readonly #resourceAuthority: ResourceAuthority;
  readonly #logger: Logger<unknown>;
  readonly #onError: (error: unknown) => unknown;
  readonly #shutdownTimeoutMilliseconds: number | undefined;
  readonly #restorationTimeoutMilliseconds: number | undefined;
  readonly #contracts = new ContractRegistry();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;
  readonly #commands = new SerialQueue();
  readonly #plans = new PlanAuthority();
  readonly #drafts = new ChangeSets();
  readonly #identities = new HostIdentities();
  readonly #retirements: Retirements;
  readonly #publisher: SnapshotPublisher<HostSnapshot>;
  #state: CommittedState;
  #transition: ExecutionTransition | undefined;
  // Diagnostics of the last failed transition: a commit clears it, but never advances because of it.
  #failure: RecordedFailure | undefined;
  // Instances that quarantine could not release; late completion only removes entries.
  #unresolved: ReadonlyArray<Instance> = Object.freeze([]);
  #quarantineWork: Promise<DougongError> | undefined;
  #observationPhase: "active" | "closing" | "closed" = "active";
  #generation = 0;

  constructor(options: HostOptions) {
    const captured = captureHostOptions(options, this.#identities);
    this.#resourceAuthority = captured.resourceAuthority;
    this.name = captured.name;
    this.#logger = captured.logger;
    this.#onError = captured.onError ?? ((error: unknown) => this.#logger.error(error));
    this.#shutdownTimeoutMilliseconds = captured.shutdownTimeoutMilliseconds;
    this.#restorationTimeoutMilliseconds = captured.restorationTimeoutMilliseconds;
    this.#contributions = new ContributionRegistry((error) => this.#report(error));
    this.#retirements = new Retirements((instance, error) =>
      this.#reportReleaseFailure(instance, error),
    );
    this.#state = Object.freeze({
      revision: 0,
      groups: captured.groups,
      graph: InstallationGraph.build(captured.declarations),
      configurations: new Map(),
      phase: "stopped",
    });
    this.#publisher = new SnapshotPublisher(
      () => this.#snapshot(),
      (error) => this.#report(error),
    );
    this.#contracts.commit(this.#state.graph.contractKinds);
    for (const record of captured.declarations.keys()) this.#attachInstallation(record);
    Object.freeze(this);
  }

  get status(): HostStatus {
    return this.#isQuarantined() ? "quarantined" : (this.#transition?.phase ?? this.#state.phase);
  }
  get stateRevision() {
    return this.#state.revision;
  }
  get diagnostics() {
    return this.#publisher.view;
  }

  installation(id: string): Installation | undefined {
    return this.#state.graph.byId.get(id)?.facade;
  }

  group(id: string): Group | undefined {
    return this.#state.groups.get(id)?.facade;
  }

  explain(id: string) {
    const { graph } = this.#state;
    const installation = graph.byId.get(id);
    return graph.bindings(installation ? [installation] : []);
  }

  change(): ChangeSet {
    this.#assertHealthy();
    return this.#drafts.create(this.#identities);
  }

  async plan(change: ChangeSet, signal?: AbortSignal): Promise<Plan> {
    this.#assertHealthy();
    const operations = this.#drafts.take(change);
    let validity = this.#plans.validationSignal;
    let detachCaller: (() => void) | undefined;
    let detachRevision: (() => void) | undefined;
    try {
      if (signal !== undefined) {
        const request = new AbortController();
        const cancel = (reason: unknown) => request.abort(reason);
        detachRevision = onAbort(validity, cancel);
        detachCaller = onAbort(signal, cancel);
        validity = request.signal;
        validity.throwIfAborted();
      }
      const prepared = await compileTransition(
        this.#state,
        operations,
        "change",
        this.#contracts,
        validity,
      );
      validity.throwIfAborted();
      // Validation is application code; a Contract kind claimed meanwhile still rejects the Plan.
      this.#contracts.assertKinds(prepared.graph.contractKinds);
      return this.#plans.issue(prepared, this.#state);
    } catch (error) {
      this.#discardPending(operations);
      throw error;
    } finally {
      detachRevision?.();
      detachCaller?.();
    }
  }

  apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#isQuarantined()) return Promise.reject(quarantinedHost(this.#state.revision));
    if (this.#transition) return Promise.reject(this.#busyTransition());
    return this.#commands.run(() => this.#execute(plan, signal), signal).then(({ value }) => value);
  }

  start(signal?: AbortSignal): Promise<ApplyResult> {
    return this.#lifecycle("start", signal);
  }
  stop(): Promise<ApplyResult> {
    return this.#lifecycle("stop");
  }

  use<T, Result>(
    requirement: Service<T> | OptionalService<T>,
    callback: (value: T | undefined) => Awaitable<Result>,
  ): Promise<ResolvedValue<Awaited<Result>>> {
    try {
      if (typeof callback !== "function")
        throw new TypeError("Service callback must be a function");
      const normalized = normalizeRequirement(requirement);
      if (normalized.kind === "extensionPoint") throw new TypeError("Expected a Service");
      const token = requiredContract(normalized);
      this.#contracts.assertCompatible(token);
      this.#assertHealthy();
      if (this.#state.phase !== "running")
        throw new DougongError(serviceUnavailableCode, "Host is not running");
      const provider = this.#state.graph.providers.get(token.id);
      if (!provider) {
        if (normalized.kind === "optional") return resolveValue(callback(undefined));
        throw new DougongError(serviceUnavailableCode, "No provider for " + token.id);
      }
      if (this.#transition?.affected.has(provider))
        throw new DougongError(serviceUnavailableCode, "Service is changing: " + token.id);
      const instance = this.#state.instances.get(provider);
      if (!instance)
        throw new DougongError(serviceUnavailableCode, "Service is not running: " + token.id);
      return instance.use<T, Result>(token.id, callback);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  contributions<T>(point: ExtensionPoint<T>) {
    const token = normalizeContract(point, "extensionPoint");
    this.#contracts.remember(token);
    return this.#contributions.view<T>(token);
  }

  #lifecycle(intent: "start" | "stop", signal?: AbortSignal) {
    if (this.#isQuarantined()) return Promise.reject(quarantinedHost(this.#state.revision));
    if (this.#transition) return Promise.reject(this.#busyTransition());
    return this.#commands
      .run(async () => {
        this.#assertHealthy();
        if (
          (intent === "start" && this.#state.phase === "running") ||
          (intent === "stop" && this.#state.phase === "stopped")
        ) {
          return this.#result([]);
        }
        // Validation is user code too: reserve the same transition before entering it.
        if (intent === "start") {
          this.#transition = new ExecutionTransition(
            "starting",
            new Set(this.#state.graph.declarations.keys()),
            signal,
          );
          this.#notify();
        }
        try {
          const prepared = await compileTransition(
            this.#state,
            [],
            intent,
            this.#contracts,
            this.#transition?.signal,
          );
          this.#transition?.checkpoint();
          return await this.#execute(this.#plans.issue(prepared, this.#state), signal);
        } finally {
          if (this.#transition) {
            this.#transition.close();
            this.#transition = undefined;
            this.#notify();
          }
        }
      }, signal)
      .then(({ value }) => value);
  }

  async #execute(plan: Plan, signal?: AbortSignal): Promise<ApplyResult> {
    this.#assertHealthy();
    if (signal) AbortSignal.prototype.throwIfAborted.call(signal);
    const prepared = this.#plans.read(plan, this.#state.revision);
    if (prepared.report.intent === "change" && prepared.report.operations.length === 0) {
      this.#plans.consume(plan);
      return this.#result([]);
    }
    const previous = this.#state;
    const affectedInstances = this.#idleAffectedInstances(previous, prepared);
    this.#plans.consume(plan);
    let writer: ContractRegistryWriter;
    try {
      writer = this.#contracts.writer(prepared.graph.contractKinds);
    } catch (error) {
      this.#detachUncommitted(prepared.graph.declarations.keys());
      throw error;
    }
    for (const instance of affectedInstances) instance.lifetime.seal();
    const reserved = this.#transition;
    // Startup validation and preparation share one visible transition; scopes are not snapshot state.
    const transition = (this.#transition =
      reserved ??
      new ExecutionTransition(
        prepared.report.intent === "stop" ? "stopping" : "changing",
        prepared.affected,
        signal,
      ));
    if (previous.phase === "running") transition.scopes.push(previous);
    // Diagnostics observers may register new contributions synchronously at transition ingress.
    this.#contributions.beginBatch();
    if (!reserved) this.#notify();
    try {
      if (previous.phase === "stopped" && prepared.report.intent !== "start") {
        transition.checkpoint();
        transition.close();
        return this.#commitStopped(prepared, writer);
      }
      await this.#stopAffected(previous, affectedInstances, prepared, writer);
      if (prepared.report.intent === "stop") return this.#commitStopped(prepared, writer);
      return await this.#startCandidate(prepared, previous, writer, transition);
    } finally {
      transition.close();
      this.#transition = undefined;
      this.#detachUncommitted(prepared.graph.declarations.keys());
      batchSnapshotNotifications(() => {
        this.#contributions.endBatch();
        this.#notify();
      });
    }
  }

  // Busy rejects before the Plan is consumed, so the caller may retry the same Plan.
  #idleAffectedInstances(previous: CommittedState, prepared: PreparedTransition) {
    if (previous.phase !== "running") return [];
    const instances = previous.graph.order
      .filter((record) => prepared.affected.has(record))
      .flatMap((record) => previous.instances.get(record) ?? []);
    const busy = instances.find((instance) => instance.lifetime.busy);
    if (busy) {
      throw new DougongError(hostBusyCode, "Affected work is still in flight", {
        details: {
          outcome: "rejected",
          installation: busy.installation.id,
          stateRevision: previous.revision,
        },
      });
    }
    return instances;
  }

  #commitStopped(prepared: PreparedTransition, writer: ContractRegistryWriter) {
    writer.commit();
    this.#commit(prepared);
    return this.#result(prepared.report.affectedInstallations);
  }

  async #stopAffected(
    previous: CommittedState,
    affectedInstances: ReadonlyArray<Instance>,
    prepared: PreparedTransition,
    writer: ContractRegistryWriter,
  ) {
    if (previous.phase !== "running") return;
    const stopErrors = await this.#retirements.release([previous], new Set(affectedInstances));
    if (
      this.#isQuarantined() ||
      stopErrors.length ||
      affectedInstances.some((instance) => instance.lifetime.phase !== "disposed")
    ) {
      writer.discard();
      throw await this.#quarantine(previous, stopErrors, prepared, "stop");
    }
  }

  async #startCandidate(
    prepared: PreparedTransition,
    previous: CommittedState,
    writer: ContractRegistryWriter,
    transition: ExecutionTransition,
  ): Promise<ApplyResult> {
    const retained = new Map(previous.phase === "running" ? previous.instances : []);
    for (const record of prepared.affected) retained.delete(record);
    const instances = new Map(retained);
    const scope: ExecutionScope = { graph: prepared.graph, instances };
    transition.scopes.push(scope);
    const failures = new PreparationFailures((error) => this.#report(error));
    try {
      await this.#prepare(prepared, instances, writer, failures, transition);
      transition.checkpoint();
      // A concurrent durable claim can still reject this candidate without publishing anything.
      writer.commit();
      transition.close();
      failures.seal();
    } catch (error) {
      writer.discard();
      throw await this.#recoverPreparation(
        previous,
        retained,
        prepared,
        scope,
        failures.seal(error),
        transition,
      );
    }
    try {
      this.#commit(prepared, instances);
    } catch (error) {
      writer.discard();
      throw await this.#quarantine(this.#state, [error], prepared, "publish");
    }
    return this.#result(prepared.report.affectedInstallations);
  }

  // Resolves to the rejection for the failed operation; it is "restored" only when the previous
  // declarations run again, and otherwise the Host is quarantined.
  async #recoverPreparation(
    previous: CommittedState,
    retained: Map<InstallationRecord, Instance>,
    prepared: PreparedTransition,
    scope: ExecutionScope,
    failure: unknown,
    transition: ExecutionTransition,
  ): Promise<DougongError> {
    if (this.#isQuarantined()) return this.#quarantine(previous, [failure], prepared, "prepare");
    const candidates = new Set(
      [...scope.instances.values()].filter((instance) =>
        prepared.affected.has(instance.installation),
      ),
    );
    const cleanupErrors = await this.#retirements.release([scope], candidates);
    if (
      this.#isQuarantined() ||
      cleanupErrors.length ||
      [...candidates].some((instance) => instance.lifetime.phase !== "disposed")
    )
      return this.#quarantine(previous, [failure, ...cleanupErrors], prepared, "prepare");
    const affected = prepared.report.affectedInstallations;
    if (previous.phase === "stopped") {
      // The committed graph is unchanged, so a failed start records diagnostics without a revision.
      this.#failure = new RecordedFailure(failure);
      return this.#transitionError("Startup failed", failure, "restored", affected, "prepare");
    }
    if (previous.phase === "quarantined") return quarantinedHost(this.#state.revision);
    await this.#restore(previous, retained, prepared, failure, transition);
    return this.#transitionError(
      "Change failed; previous declarations were restored",
      failure,
      "restored",
      affected,
      "prepare",
    );
  }

  async #prepare(
    prepared: Pick<PreparedTransition, "graph" | "affected" | "configurations">,
    execution: Map<InstallationRecord, Instance>,
    writer: ContractRegistryWriter,
    failures: PreparationFailures,
    transition: ExecutionTransition,
  ) {
    const generation = ++this.#generation;
    for (const layer of prepared.graph.layers) {
      this.#assertHealthy();
      transition.checkpoint();
      // Prepared providers must stay available until their consumers finish cleanup.
      const layerCancellation = new AbortController();
      const detachCancellation = onAbort(transition.signal, (reason) =>
        layerCancellation.abort(reason),
      );
      try {
        const instances = layer
          .filter((record) => prepared.affected.has(record))
          .map((record) => {
            const instance = new Instance(
              record,
              prepared.graph.declarationFor(record),
              generation,
              {
                resourceAuthority: this.#resourceAuthority,
                hostName: this.name,
                logger: this.#logger,
                report: (error) => this.#report(error),
                releaseFailed: (failure) => this.#releaseFailed(instance, failure),
                changed: () => {
                  if (
                    (this.#state.phase === "running" &&
                      this.#state.instances.get(record) === instance) ||
                    this.#unresolved.includes(instance)
                  )
                    this.#notify();
                },
                events: this.#events,
                contributions: this.#contributions,
                contracts: writer,
                startupSignal: layerCancellation.signal,
                shutdownTimeoutMilliseconds: this.#shutdownTimeoutMilliseconds,
              },
            );
            execution.set(record, instance);
            return instance;
          });
        const preparation = Promise.all(
          instances.map(async (instance) => {
            const signal = instance.lifetime.signal;
            const dependencies: Record<string, unknown> = Object.create(null);
            for (const [alias, requirement] of Object.entries(
              instance.declaration.plugin.requires,
            )) {
              if (requirement.kind === "extensionPoint") {
                dependencies[alias] = this.#contributions.view(requirement, instance.lifetime);
                continue;
              }
              const contract = requiredContract(requirement).id;
              const provider = prepared.graph.providers.get(contract);
              dependencies[alias] = provider ? execution.get(provider)?.read(contract) : undefined;
            }
            try {
              await instance.prepare(
                Object.freeze(dependencies),
                prepared.configurations.get(instance.installation)?.value,
              );
            } catch (error) {
              if (!isCancellationReason(signal, error)) failures.add(error);
              layerCancellation.abort(error);
              throw error;
            }
          }),
        );
        await transition.waitFor(preparation);
        this.#assertHealthy();
        for (const instance of instances)
          AbortSignal.prototype.throwIfAborted.call(instance.lifetime.signal);
      } catch (error) {
        layerCancellation.abort(error);
        throw error;
      } finally {
        detachCancellation();
      }
    }
  }

  async #restore(
    previous: Extract<CommittedState, { readonly phase: "running" }>,
    retained: Map<InstallationRecord, Instance>,
    failed: PreparedTransition,
    error: unknown,
    transition: ExecutionTransition,
  ) {
    this.#assertHealthy();
    const instances = new Map(retained);
    const scope: ExecutionScope = { graph: previous.graph, instances };
    transition.scopes.push(scope);
    const failures = new PreparationFailures((failure) => this.#report(failure));
    const writer = this.#contracts.writer(previous.graph.contractKinds);
    try {
      transition.beginRestoration(this.#restorationTimeoutMilliseconds);
      await this.#prepare(
        {
          graph: previous.graph,
          affected: failed.affected,
          configurations: previous.configurations,
        },
        instances,
        writer,
        failures,
        transition,
      );
      transition.checkpoint();
      failures.seal();
      writer.commit();
      transition.close();
      const recorded = new RecordedFailure(error);
      this.#advance({ ...previous, instances });
      this.#failure = recorded;
      for (const [record, instance] of instances) {
        if (failed.affected.has(record)) instance.publish();
        this.#assertHealthy();
      }
    } catch (restoreError) {
      transition.close();
      writer.discard();
      const cleanupErrors = this.#isQuarantined()
        ? []
        : await this.#retirements.release(
            [scope],
            new Set(
              [...instances.values()].filter((instance) =>
                failed.affected.has(instance.installation),
              ),
            ),
          );
      throw await this.#quarantine(
        previous,
        [error, failures.seal(restoreError), ...cleanupErrors],
        failed,
        "restore",
      );
    }
  }

  #commit(prepared: PreparedTransition, instances?: ReadonlyMap<InstallationRecord, Instance>) {
    const previous = this.#state;
    this.#advance({
      groups: prepared.groups,
      graph: prepared.graph,
      configurations: prepared.configurations,
      ...(instances === undefined
        ? { phase: "stopped" as const }
        : { phase: "running" as const, instances }),
    });
    this.#failure = undefined;
    this.#assertHealthy();
    for (const record of prepared.graph.declarations.keys()) {
      if (!previous.graph.declarations.has(record)) this.#attachInstallation(record);
    }
    for (const record of previous.graph.declarations.keys()) {
      if (!prepared.graph.declarations.has(record))
        record.detach({ status: "removed", origin: undefined });
    }
    for (const [record, instance] of instances ?? []) {
      if (prepared.affected.has(record)) instance.publish();
      this.#assertHealthy();
    }
  }

  #advance(next: NextCommittedState) {
    this.#assertHealthy();
    const revision = this.#state.revision + 1;
    this.#state = Object.freeze({ ...next, revision });
    if (next.phase !== "quarantined") {
      this.#plans.invalidate(stalePlan(revision - 1, revision));
      return;
    }
    this.#plans.invalidate(quarantinedHost(revision));
    this.#drafts.close(revision);
    for (const [record, declaration] of next.graph.declarations)
      record.detach({ status: "quarantined", origin: declaration.origin });
  }

  #releaseFailed(instance: Instance, failure: ReleaseFailure) {
    if (this.#isQuarantined()) return;
    const root = instance.lifetime;
    // A descendant deadline rejects its own receipt, not the actual shutdown work joined by the root.
    const descendantDeadline = failure.kind === "shutdown" && failure.owner !== root;
    if (!descendantDeadline && root.phase !== "active" && root.phase !== "sealed") return;
    const record = instance.installation;
    if (
      (this.#state.phase !== "running" || this.#state.instances.get(record) !== instance) &&
      !this.#transition?.scopes.some((scope) => scope.instances.get(record) === instance)
    )
      return;
    this.#reportReleaseFailure(instance, failure.error);
  }

  #quarantine(
    previous: CommittedState,
    errors: ReadonlyArray<unknown>,
    prepared: PreparedTransition | undefined,
    phase: FailurePhase,
  ): Promise<DougongError> {
    if (this.#quarantineWork || this.#isQuarantined()) {
      const work = this.#quarantineWork ?? Promise.resolve(quarantinedHost(this.#state.revision));
      if (!errors.length) return work;
      // A concurrent operation owns its failure receipt, not another Host health transition.
      return work.then((quarantine) =>
        this.#transitionError(
          "Operation failed while Host was quarantined",
          new AggregateError([...errors, quarantine], "Execution failed during quarantine"),
          "quarantined",
          prepared?.report.affectedInstallations ?? [],
          phase,
        ),
      );
    }
    const execution = [
      ...(previous.phase === "running" ? [previous] : []),
      ...(this.#transition?.scopes ?? []),
    ];
    const owned = new Set(execution.flatMap((scope) => [...scope.instances.values()]));
    const remaining = [...owned].filter((instance) => instance.lifetime.phase !== "disposed");
    const affectedInstallations = prepared?.report.affectedInstallations ?? [
      ...new Set(remaining.map((instance) => instance.installation.id)),
    ];
    const work = Promise.resolve().then(async () => {
      const cleanupErrors = await this.#retirements.release(execution, new Set(remaining));
      const cause = new AggregateError([...errors, ...cleanupErrors], quarantineFailureMessage);
      // Cleanup completion refines diagnostics; it cannot grant another committed revision.
      this.#unresolved = Object.freeze(
        remaining.filter((instance) => instance.lifetime.phase !== "disposed"),
      );
      if (cleanupErrors.length) this.#appendFailures(cleanupErrors);
      this.#notify();
      return this.#transitionError(
        "Host is quarantined after execution could not establish a healthy state",
        cause,
        "quarantined",
        affectedInstallations,
        phase,
      );
    });
    // Reserve the single join before invalidation or notification can reenter the Engine.
    this.#quarantineWork = work;
    const forget = () => {
      this.#quarantineWork = undefined;
      this.#sealObservationsWhenComplete();
    };
    void work.then(forget, forget);
    for (const instance of remaining) instance.lifetime.block();
    this.#advance({
      phase: "quarantined",
      groups: previous.groups,
      graph: previous.graph,
      configurations: previous.configurations,
    });
    this.#unresolved = Object.freeze(remaining);
    this.#failure = undefined;
    this.#notify();
    // Reading an external Error can execute accessors; availability is already terminal.
    this.#failure = new RecordedFailure(new AggregateError(errors, quarantineFailureMessage));
    this.#notify();
    return work;
  }

  #appendFailures(errors: ReadonlyArray<unknown>) {
    this.#failure = new RecordedFailure(
      new AggregateError([this.#failure, ...errors], quarantineFailureMessage),
    );
  }

  #reportReleaseFailure(instance: Instance, error: unknown) {
    if (!this.#isQuarantined()) {
      void this.#quarantine(this.#state, [error], undefined, "release").then(
        (failure) => this.#report(failure),
        (failure) => this.#report(failure),
      );
      return;
    }
    this.#appendFailures([error]);
    this.#notify();
    this.#report(
      this.#transitionError(
        "Instance release failed after Host quarantine",
        error,
        "quarantined",
        [instance.installation.id],
        "release",
      ),
    );
  }

  #transitionError(
    message: string,
    cause: unknown,
    outcome: "restored" | "quarantined",
    affectedInstallations: ReadonlyArray<string>,
    phase: FailurePhase,
  ) {
    const code = outcome === "restored" ? transitionFailedCode : hostQuarantinedCode;
    return new DougongError(code, message, {
      cause,
      details: {
        outcome,
        phase,
        stateRevision: this.#state.revision,
        affectedInstallations,
      },
    });
  }

  #result(affectedInstallations: ReadonlyArray<string>): ApplyResult {
    return Object.freeze({
      stateRevision: this.#state.revision,
      affectedInstallations: Object.freeze([...affectedInstallations]),
    });
  }

  #isQuarantined(): boolean {
    return this.#state.phase === "quarantined";
  }

  #assertHealthy() {
    if (this.#isQuarantined()) throw quarantinedHost(this.#state.revision);
  }

  #busyTransition() {
    return new DougongError(hostBusyCode, "Another Host transition is in progress", {
      details: { outcome: "rejected", stateRevision: this.#state.revision },
    });
  }

  #attachInstallation(record: InstallationRecord) {
    record.attach(() => ({
      status: this.#installationStatus(record),
      origin: this.#state.graph.declarations.get(record)?.origin,
    }));
  }

  #detachUncommitted(records: Iterable<InstallationRecord>) {
    for (const record of records) {
      if (!this.#state.graph.declarations.has(record))
        record.detach({ status: "removed", origin: undefined });
    }
  }

  #discardPending(operations: ReadonlyArray<ChangeOperation>) {
    this.#detachUncommitted(
      operations.flatMap((operation) =>
        operation.kind === "install" ? [operation.installation] : [],
      ),
    );
  }

  #installationStatus(record: InstallationRecord): InstallationState {
    if (!this.#state.graph.declarations.has(record)) return "pending";
    return installationExecution(record, this.#state, this.#transition?.affected).status;
  }

  #snapshot(): HostSnapshot {
    return projectHostSnapshot({
      name: this.name,
      status: this.status,
      state: this.#state,
      changing: this.#transition?.affected,
      unresolved: this.#unresolved,
      failure: this.#failure,
    });
  }

  #notify() {
    if (this.#unresolved.some((instance) => instance.lifetime.phase === "disposed")) {
      this.#unresolved = Object.freeze(
        this.#unresolved.filter((instance) => instance.lifetime.phase !== "disposed"),
      );
    }
    if (this.#observationPhase === "closed") return;
    try {
      batchSnapshotNotifications(
        () => this.#publisher.invalidate(),
        (error) => this.#report(error),
      );
    } catch (error) {
      this.#report(error);
    }
    this.#sealObservationsWhenComplete();
  }

  #sealObservationsWhenComplete() {
    if (
      this.#observationPhase !== "active" ||
      !this.#isQuarantined() ||
      this.#transition ||
      this.#quarantineWork ||
      this.#unresolved.length
    )
      return;
    this.#observationPhase = "closing";
    // The enclosing notification batch must deliver its final snapshot before subscriptions detach.
    queueMicrotask(() => {
      this.#observationPhase = "closed";
      const errors: unknown[] = [];
      try {
        this.#contributions.sealHostViews();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.#publisher[disposeSymbol]();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) this.#report(combineFailures(errors, "Host observation sealing failed"));
    });
  }

  #report(error: unknown) {
    const logger = this.#logger;
    const fallback = (failure: unknown) => {
      try {
        void resolveValue(
          logger.error(new AggregateError([error, failure], "Host error reporter failed")),
        ).catch(() => undefined);
      } catch {
        // There is no lower reporting boundary; observer errors must not rewrite a committed outcome.
      }
    };
    try {
      const report = this.#onError;
      void resolveValue(report(error)).catch(fallback);
    } catch (failure) {
      fallback(failure);
    }
  }
}
