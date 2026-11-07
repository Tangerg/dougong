import { shutdownTimeout, type ReleaseFailure } from "../lifetime/lifetime.js";
import { ContractRegistry } from "../contracts/contract-registry.js";
import {
  DougongError,
  isCancellationReason,
  quarantinedHost,
  RecordedFailure,
  type ErrorSnapshot,
  groupConflictCode,
  groupForeignCode,
  groupMissingCode,
  hostBusyCode,
  hostQuarantinedCode,
  installationForeignCode,
  serviceUnavailableCode,
  transitionFailedCode,
} from "../contracts/errors.js";
import {
  normalizeRequirement,
  normalizeContract,
  type Service,
  type OptionalService,
  type ExtensionPoint,
} from "../contracts/contracts.js";
import { captureLogger, type Logger } from "../contracts/logging.js";
import { EventHub } from "../events/event-hub.js";
import { ContributionRegistry } from "../contributions/contribution-store.js";
import { SnapshotPublisher, batchSnapshotNotifications } from "../observation/snapshot-view.js";
import { onAbort } from "../internal/abort.js";
import { SerialQueue } from "../internal/serial-queue.js";
import { captureDataArray } from "../internal/data-array.js";
import { resolveValue, type ResolvedValue } from "../internal/async-result.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { ChangeSets, assertId, type ChangeOperation } from "../composition/change-set.js";
import {
  captureInstallationDeclaration,
  claimInstallationId,
  InstallationRecord,
  type InstallationDeclaration,
} from "../composition/installation.js";
import { InstallationGraph } from "../composition/installation-graph.js";
import { buildInitialGroups, GroupNode } from "../composition/group.js";
import { compileTransition, type CompositionState } from "../composition/planner.js";
import {
  PlanAuthority,
  describeBindings,
  type Plan,
  type PreparedTransition,
} from "../composition/plan.js";
import { Instance } from "./instance.js";
import type { ApplyResult, HostOptions } from "./host-api.js";
import type {
  ChangeSet,
  Group,
  Installation,
  InitialInstallation,
} from "../composition/declarations.js";
import type { HostStatus, InstallationState } from "../contracts/status.js";
import type { HostSnapshot, InstallationSnapshot } from "../inspection/diagnostics.js";
import { disposeSymbol, type Awaitable } from "../contracts/resource.js";

interface CommittedState extends CompositionState {
  readonly phase: "stopped" | "running" | "quarantined";
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
  readonly unresolved: ReadonlyArray<Instance>;
  readonly error: ErrorSnapshot | undefined;
}

interface Transition {
  readonly phase: "starting" | "changing" | "stopping";
  readonly affected: ReadonlySet<InstallationRecord>;
  readonly scopes: ExecutionScope[];
}

interface ExecutionScope {
  readonly graph: InstallationGraph;
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
}

type FailurePhase = "stop" | "prepare" | "restore" | "publish" | "release";

const hostOptionFields = recordFields<HostOptions>()(
  "name",
  "installations",
  "groups",
  "logger",
  "onError",
  "shutdownTimeoutMilliseconds",
);
const initialGroupFields = recordFields<NonNullable<HostOptions["groups"]>[number]>()(
  "id",
  "parentId",
);
const initialInstallationFields = recordFields<InitialInstallation>()(
  "id",
  "plugin",
  "configuration",
  "origin",
  "groupId",
);

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
    return failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Plugin preparation failed");
  }
}

export class Engine {
  readonly name: string;
  readonly #logger: Logger<unknown>;
  readonly #onError: (error: unknown) => unknown;
  readonly #shutdownTimeoutMilliseconds: number | undefined;
  readonly #contracts = new ContractRegistry();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;
  readonly #commands = new SerialQueue();
  readonly #plans = new PlanAuthority();
  readonly #drafts = new ChangeSets();
  readonly #installations = new WeakMap<object, InstallationRecord>();
  readonly #groups = new WeakMap<object, GroupNode>();
  readonly #publisher: SnapshotPublisher<HostSnapshot>;
  #state: CommittedState;
  #transition: Transition | undefined;
  #quarantineWork: Promise<DougongError> | undefined;
  #observationPhase: "active" | "closing" | "closed" = "active";
  #generation = 0;

  constructor(options: HostOptions = {}) {
    const input = normalizePlainRecord(options, "Host options", {
      fields: hostOptionFields,
    });
    const name = input.name === undefined ? "host" : input.name;
    assertId(name, "Host name");
    this.name = name;
    if (input.onError !== undefined && typeof input.onError !== "function")
      throw new TypeError("Host onError must be a function");

    this.#logger = captureLogger(input.logger === undefined ? console : input.logger);
    this.#onError = (input.onError ?? ((error: unknown) => this.#logger.error(error))) as (
      error: unknown,
    ) => unknown;
    this.#shutdownTimeoutMilliseconds = shutdownTimeout(input.shutdownTimeoutMilliseconds);
    this.#contributions = new ContributionRegistry((error) => this.#report(error));
    const declarations = new Map<InstallationRecord, InstallationDeclaration>();
    const initialGroups = captureDataArray(
      input.groups === undefined ? [] : input.groups,
      "Initial Groups",
    );
    const initialInstallations = captureDataArray(
      input.installations === undefined ? [] : input.installations,
      "Initial Installations",
    );
    const groupParents = new Map<string, string | undefined>();
    for (const raw of initialGroups) {
      const group = normalizePlainRecord(raw, "Initial Group", {
        fields: initialGroupFields,
      });
      assertId(group.id, "Group id");
      if (group.parentId !== undefined) assertId(group.parentId, "Parent Group id");
      if (groupParents.has(group.id))
        throw new DougongError(groupConflictCode, "Duplicate initial Group: " + group.id);
      groupParents.set(group.id, group.parentId as string | undefined);
    }
    const groups = buildInitialGroups(groupParents, (id, parent) => this.#createGroup(id, parent));
    const ids = new Set<string>();
    for (const raw of initialInstallations) {
      const initial = normalizePlainRecord(raw, "Initial Installation", {
        fields: initialInstallationFields,
      });
      assertId(initial.id, "Installation id");
      if (initial.groupId !== undefined) assertId(initial.groupId, "Installation Group id");
      claimInstallationId(ids, initial.id);
      const group =
        initial.groupId === undefined ? undefined : groups.get(initial.groupId as string);
      if (initial.groupId !== undefined && !group)
        throw new DougongError(groupMissingCode, "Initial Group is missing: " + initial.groupId);
      const record = this.#createInstallation(initial.id, group);
      declarations.set(
        record,
        captureInstallationDeclaration(initial.plugin, initial.configuration, initial.origin),
      );
    }
    this.#state = Object.freeze({
      revision: 0,
      groups,
      graph: InstallationGraph.build(declarations),
      configurations: new Map(),
      phase: "stopped",
      instances: new Map(),
      unresolved: Object.freeze([]),
      error: undefined,
    });
    this.#publisher = new SnapshotPublisher(
      () => this.#snapshot(),
      (error) => this.#report(error),
    );
    this.#contracts.commit(this.#state.graph.contractKinds);
    for (const record of declarations.keys()) this.#attachInstallation(record);
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
    return describeBindings(graph, installation ? [installation] : []);
  }

  change(): ChangeSet {
    this.#assertHealthy();
    return this.#drafts.create({
      create: (id, group) => this.#createInstallation(id, group),
      resolve: (handle) => this.#resolveInstallation(handle),
      createGroup: (id, parent) => this.#createGroup(id, parent),
      resolveGroup: (handle) => {
        const group = this.#groups.get(handle);
        if (!group) throw new DougongError(groupForeignCode, "Group belongs to another Host");
        return group;
      },
    });
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

  apply(plan: Plan): Promise<ApplyResult> {
    if (this.#isQuarantined()) return Promise.reject(quarantinedHost(this.#state.revision));
    if (this.#transition) return Promise.reject(this.#busyTransition());
    return this.#commands.run(() => this.#execute(plan)).then(({ value }) => value);
  }

  start(): Promise<ApplyResult> {
    return this.#lifecycle("start");
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
      const token = normalized.kind === "optional" ? normalized.service : normalized;
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

  #lifecycle(intent: "start" | "stop") {
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
          this.#transition = {
            phase: "starting",
            affected: new Set(this.#state.graph.declarations.keys()),
            scopes: [],
          };
          this.#notify();
        }
        try {
          const prepared = await compileTransition(this.#state, [], intent, this.#contracts);
          return await this.#execute(this.#plans.issue(prepared, this.#state));
        } finally {
          if (this.#transition) {
            this.#transition = undefined;
            this.#notify();
          }
        }
      })
      .then(({ value }) => value);
  }

  async #execute(plan: Plan): Promise<ApplyResult> {
    this.#assertHealthy();
    const prepared = this.#plans.read(plan, this.#state.revision);
    if (prepared.report.intent === "change" && prepared.report.operations.length === 0) {
      this.#plans.consume(plan);
      return this.#result([]);
    }
    const previous = this.#state;
    const affectedInstances = previous.graph.order
      .filter((record) => prepared.affected.has(record))
      .flatMap((record) => previous.instances.get(record) ?? []);
    for (const instance of affectedInstances) {
      if (instance.lifetime.busy) {
        throw new DougongError(hostBusyCode, "Affected work is still in flight", {
          details: {
            outcome: "rejected",
            installation: instance.installation.id,
            stateRevision: previous.revision,
          },
        });
      }
    }
    this.#plans.consume(plan);
    let writer: ReturnType<ContractRegistry["writer"]>;
    try {
      writer = this.#contracts.writer(prepared.graph.contractKinds);
    } catch (error) {
      this.#detachUncommitted(prepared.graph.declarations.keys());
      throw error;
    }
    for (const instance of affectedInstances) instance.lifetime.seal();
    const reserved = this.#transition;
    // Startup validation and preparation share one visible transition; scopes are not snapshot state.
    this.#transition = reserved ?? {
      phase: prepared.report.intent === "stop" ? "stopping" : "changing",
      affected: prepared.affected,
      scopes: [],
    };
    this.#transition.scopes.push(previous);
    // Diagnostics observers may register new contributions synchronously at transition ingress.
    this.#contributions.beginBatch();
    if (!reserved) this.#notify();
    try {
      if (previous.phase === "stopped" && prepared.report.intent !== "start") {
        writer.commit();
        this.#commit(prepared, new Map(), "stopped");
        return this.#result(prepared.report.affectedInstallations);
      }
      const stopErrors = await this.#dispose([previous], new Set(affectedInstances));
      if (
        this.#isQuarantined() ||
        stopErrors.length ||
        affectedInstances.some((instance) => instance.lifetime.phase !== "disposed")
      ) {
        writer.discard();
        throw await this.#quarantine(previous, stopErrors, prepared, "stop");
      }
      if (prepared.report.intent === "stop") {
        writer.commit();
        this.#commit(prepared, new Map(), "stopped");
        return this.#result(prepared.report.affectedInstallations);
      }
      const retained = new Map(previous.instances);
      for (const record of prepared.affected) retained.delete(record);
      const instances = new Map(retained);
      const scope: ExecutionScope = { graph: prepared.graph, instances };
      this.#transition.scopes.push(scope);
      const failures = new PreparationFailures((error) => this.#report(error));
      try {
        await this.#prepare(prepared, instances, writer, failures);
        // A concurrent durable claim can still reject this candidate without publishing anything.
        writer.commit();
        failures.seal();
      } catch (error) {
        writer.discard();
        const failure = failures.seal(error);
        if (this.#isQuarantined())
          throw await this.#quarantine(previous, [failure], prepared, "prepare");
        const candidates = new Set(
          [...instances.values()].filter((instance) =>
            prepared.affected.has(instance.installation),
          ),
        );
        const cleanupErrors = await this.#dispose([scope], candidates);
        if (
          this.#isQuarantined() ||
          cleanupErrors.length ||
          [...candidates].some((instance) => instance.lifetime.phase !== "disposed")
        )
          throw await this.#quarantine(previous, [failure, ...cleanupErrors], prepared, "prepare");
        if (previous.phase === "stopped") {
          this.#advance({
            ...previous,
            error: new RecordedFailure(failure).snapshot,
          });
          throw this.#transitionError(
            "Startup failed",
            failure,
            "restored",
            prepared.report.affectedInstallations,
            "prepare",
          );
        }
        await this.#restore(previous, retained, prepared, failure);
        throw this.#transitionError(
          "Change failed; previous declarations were restored",
          failure,
          "restored",
          prepared.report.affectedInstallations,
          "prepare",
        );
      }
      try {
        this.#commit(prepared, instances, "running");
      } catch (error) {
        writer.discard();
        throw await this.#quarantine(this.#state, [error], prepared, "publish");
      }
      return this.#result(prepared.report.affectedInstallations);
    } finally {
      this.#transition = undefined;
      this.#detachUncommitted(prepared.graph.declarations.keys());
      batchSnapshotNotifications(() => {
        this.#contributions.endBatch();
        this.#notify();
      });
    }
  }

  async #prepare(
    prepared: Pick<PreparedTransition, "graph" | "affected" | "configurations">,
    execution: Map<InstallationRecord, Instance>,
    writer: ReturnType<ContractRegistry["writer"]>,
    failures: PreparationFailures,
  ) {
    const startup = new AbortController();
    const generation = ++this.#generation;
    for (const layer of prepared.graph.layers) {
      this.#assertHealthy();
      const instances = layer
        .filter((record) => prepared.affected.has(record))
        .map((record) => {
          const instance = new Instance(record, prepared.graph.declarationFor(record), generation, {
            hostName: this.name,
            logger: this.#logger,
            report: (error) => this.#report(error),
            releaseFailed: (failure) => this.#releaseFailed(instance, failure),
            changed: () => {
              if (
                this.#state.instances.get(record) === instance ||
                this.#state.unresolved.includes(instance)
              )
                this.#notify();
            },
            events: this.#events,
            contributions: this.#contributions,
            contracts: writer,
            startupSignal: startup.signal,
            shutdownTimeoutMilliseconds: this.#shutdownTimeoutMilliseconds,
          });
          execution.set(record, instance);
          return instance;
        });
      try {
        await Promise.all(
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
              const token = requirement.kind === "optional" ? requirement.service : requirement;
              const provider = prepared.graph.providers.get(token.id);
              dependencies[alias] = provider ? execution.get(provider)?.read(token.id) : undefined;
            }
            try {
              await instance.prepare(
                Object.freeze(dependencies),
                prepared.configurations.get(instance.installation)?.value,
              );
            } catch (error) {
              if (!isCancellationReason(signal, error)) failures.add(error);
              startup.abort(error);
              throw error;
            }
          }),
        );
        this.#assertHealthy();
        for (const instance of instances)
          AbortSignal.prototype.throwIfAborted.call(instance.lifetime.signal);
      } catch (error) {
        startup.abort(error);
        throw error;
      }
    }
  }

  async #restore(
    previous: CommittedState,
    retained: Map<InstallationRecord, Instance>,
    failed: PreparedTransition,
    error: unknown,
  ) {
    this.#assertHealthy();
    const instances = new Map(retained);
    const scope: ExecutionScope = { graph: previous.graph, instances };
    this.#transition!.scopes.push(scope);
    const failures = new PreparationFailures((error) => this.#report(error));
    const writer = this.#contracts.writer(previous.graph.contractKinds);
    try {
      await this.#prepare(
        {
          graph: previous.graph,
          affected: failed.affected,
          configurations: previous.configurations,
        },
        instances,
        writer,
        failures,
      );
      failures.seal();
      writer.commit();
      this.#advance({
        ...previous,
        instances,
        error: new RecordedFailure(error).snapshot,
      });
      for (const [record, instance] of instances) {
        if (failed.affected.has(record)) instance.publish();
        this.#assertHealthy();
      }
    } catch (restoreError) {
      writer.discard();
      const cleanupErrors = this.#isQuarantined()
        ? []
        : await this.#dispose(
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

  #commit(
    prepared: PreparedTransition,
    instances: ReadonlyMap<InstallationRecord, Instance>,
    phase: "stopped" | "running",
  ) {
    const previous = this.#state;
    this.#advance({
      groups: prepared.groups,
      graph: prepared.graph,
      configurations: prepared.configurations,
      phase,
      instances,
      unresolved: Object.freeze([]),
      error: undefined,
    });
    this.#assertHealthy();
    for (const record of prepared.graph.declarations.keys()) {
      if (!previous.graph.declarations.has(record)) this.#attachInstallation(record);
    }
    for (const record of previous.graph.declarations.keys()) {
      if (!prepared.graph.declarations.has(record))
        record.detach({ status: "removed", origin: undefined });
    }
    for (const [record, instance] of instances) {
      if (prepared.affected.has(record)) instance.publish();
      this.#assertHealthy();
    }
  }

  #advance(next: Omit<CommittedState, "revision">) {
    this.#assertHealthy();
    this.#state = Object.freeze({ ...next, revision: this.#state.revision + 1 });
    const quarantined = next.phase === "quarantined";
    this.#plans.invalidate(this.#state.revision, quarantined);
    if (quarantined) {
      this.#drafts.close(this.#state.revision);
      for (const [record, declaration] of next.graph.declarations) {
        record.detach({ status: "quarantined", origin: declaration.origin });
      }
    }
  }

  #releaseFailed(instance: Instance, failure: ReleaseFailure) {
    if (this.#isQuarantined()) return;
    const root = instance.lifetime;
    // A descendant deadline rejects its own receipt, not the actual shutdown work joined by the root.
    const descendantDeadline = failure.kind === "shutdown" && failure.owner !== root;
    if (!descendantDeadline && root.phase !== "active" && root.phase !== "sealed") return;
    const record = instance.installation;
    if (
      this.#state.instances.get(record) !== instance &&
      !this.#transition?.scopes.some((scope) => scope.instances.get(record) === instance)
    )
      return;
    void this.#quarantine(this.#state, [failure.error], undefined, "release").then(
      (failure) => this.#report(failure),
      (failure) => this.#report(failure),
    );
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
    const execution = [previous, ...(this.#transition?.scopes ?? [])];
    const owned = new Set(execution.flatMap((scope) => [...scope.instances.values()]));
    const remaining = [...owned].filter((instance) => instance.lifetime.phase !== "disposed");
    const affectedInstallations = prepared?.report.affectedInstallations ?? [
      ...new Set(remaining.map((instance) => instance.installation.id)),
    ];
    const failureMessage = "Execution could not establish a healthy state";
    const work = Promise.resolve().then(async () => {
      const cleanupErrors = await this.#dispose(execution, new Set(remaining));
      const cause = new AggregateError([...errors, ...cleanupErrors], failureMessage);
      // Cleanup completion refines diagnostics; it cannot grant another committed revision.
      this.#state = Object.freeze({
        ...this.#state,
        unresolved: Object.freeze(
          remaining.filter((instance) => instance.lifetime.phase !== "disposed"),
        ),
        error: new RecordedFailure(cause).snapshot,
      });
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
      ...previous,
      phase: "quarantined",
      instances: new Map(),
      unresolved: Object.freeze(remaining),
      error: undefined,
    });
    this.#notify();
    // Reading an external Error can execute accessors; availability is already terminal.
    this.#state = Object.freeze({
      ...this.#state,
      error: new RecordedFailure(new AggregateError(errors, failureMessage)).snapshot,
    });
    this.#notify();
    return work;
  }

  async #dispose(scopes: ReadonlyArray<ExecutionScope>, targets: ReadonlySet<Instance>) {
    const dependents = new Map<Instance, Set<Instance>>();
    for (const { graph, instances } of scopes) {
      for (const [provider, consumers] of graph.dependents) {
        const instance = instances.get(provider);
        if (!instance) continue;
        const bound = dependents.get(instance) ?? new Set<Instance>();
        for (const consumer of consumers) {
          const dependent = instances.get(consumer);
          if (dependent) bound.add(dependent);
        }
        dependents.set(instance, bound);
      }
    }

    const pending = new Map<Instance, Promise<void>>();
    for (const instance of [...targets].reverse()) {
      // Register every branch before looking up joins, including bindings across generations.
      pending.set(
        instance,
        Promise.resolve().then(async () => {
          const consumers = [...(dependents.get(instance) ?? [])];
          await Promise.allSettled(consumers.map((consumer) => pending.get(consumer)));
          if (
            consumers.some((consumer) => consumer.lifetime.phase !== "disposed") ||
            instance.lifetime.busy ||
            instance.lifetime.phase === "disposed" ||
            instance.lifetime.phase === "quarantined"
          )
            return;
          await instance.dispose();
        }),
      );
    }
    const outcomes = await Promise.allSettled(pending.values());
    return outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
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

  #createInstallation(id: string, group: GroupNode | undefined) {
    const record = new InstallationRecord(id, group);
    this.#installations.set(record.facade, record);
    return record;
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

  #createGroup(id: string, parent: GroupNode | undefined) {
    const group = new GroupNode(id, parent);
    this.#groups.set(group.facade, group);
    return group;
  }

  #resolveInstallation(handle: object) {
    const record = this.#installations.get(handle);
    if (!record)
      throw new DougongError(installationForeignCode, "Installation belongs to another Host");
    return record;
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
    return this.#installationExecution(record).status;
  }

  #installationExecution(record: InstallationRecord) {
    const instance = this.#state.instances.get(record);
    const changing = this.#transition?.affected.has(record);
    if (instance) {
      return { status: changing ? "changing" : "running", instance } as const;
    }
    return {
      status: this.#isQuarantined() ? "quarantined" : changing ? "changing" : "stopped",
      instance: undefined,
    } as const;
  }

  #snapshot(): HostSnapshot {
    const installations: InstallationSnapshot[] = [...this.#state.graph.declarations].map(
      ([record, declaration]) => {
        const execution = this.#installationExecution(record);
        const description = {
          id: record.id,
          groupId: record.groupId,
          pluginName: declaration.plugin.name,
          origin: declaration.origin,
          requires: Object.freeze(
            Object.values(declaration.plugin.requires).map((token) =>
              token.kind === "optional" ? token.service.id : token.id,
            ),
          ),
          provides: Object.freeze(
            Object.values(declaration.plugin.provides).map((token) => token.id),
          ),
        };
        if (!execution.instance) {
          return Object.freeze({
            ...description,
            status: execution.status,
            generation: undefined,
            lifetime: undefined,
          });
        }
        return Object.freeze({
          ...description,
          status: execution.status,
          generation: execution.instance.generation,
          lifetime: execution.instance.lifetime.snapshot(),
        });
      },
    );
    const members = Map.groupBy(installations, (installation) => installation.groupId);
    return Object.freeze({
      name: this.name,
      status: this.status,
      stateRevision: this.#state.revision,
      installations: Object.freeze(installations),
      groups: Object.freeze(
        [...this.#state.groups.values()].map((group) =>
          Object.freeze({
            id: group.id,
            parentId: group.parentId,
            installations: Object.freeze(
              (members.get(group.id) ?? []).map((installation) => installation.id),
            ),
          }),
        ),
      ),
      bindings: describeBindings(this.#state.graph),
      unresolved: Object.freeze(
        this.#state.unresolved.map((instance) =>
          Object.freeze({
            installation: instance.installation.id,
            generation: instance.generation,
            lifetime: instance.lifetime.snapshot(),
          }),
        ),
      ),
      error: this.#state.error,
    });
  }

  #notify() {
    if (this.#state.unresolved.some((instance) => instance.lifetime.phase === "disposed")) {
      this.#state = Object.freeze({
        ...this.#state,
        unresolved: Object.freeze(
          this.#state.unresolved.filter((instance) => instance.lifetime.phase !== "disposed"),
        ),
      });
    }
    if (this.#observationPhase === "closed") return;
    try {
      this.#publisher.invalidate();
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
      this.#state.unresolved.length
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
      if (errors.length === 1) this.#report(errors[0]);
      if (errors.length > 1)
        this.#report(new AggregateError(errors, "Host observation sealing failed"));
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
