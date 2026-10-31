import { ContractRegistry } from "../contracts/contract-registry.js";
import { DougongError, RecordedFailure, type ErrorSnapshot } from "../contracts/errors.js";
import {
  normalizeRequirement,
  normalizeContract,
  type Service,
  type OptionalService,
  type ExtensionPoint,
} from "../contracts/contracts.js";
import { isLogger, type Logger } from "../contracts/logging.js";
import { EventHub } from "../events/event-hub.js";
import { ContributionRegistry } from "../contributions/contribution-store.js";
import { SnapshotPublisher, batchSnapshotNotifications } from "../observation/snapshot-view.js";
import { SerialQueue } from "../internal/serial-queue.js";
import { normalizePlainRecord } from "../internal/record.js";
import {
  ChangeSetDraft,
  assertId,
  captureOrigin,
  type ChangeOperation,
} from "../composition/change-set.js";
import { InstallationRecord, type InstallationDeclaration } from "../composition/installation.js";
import { InstallationGraph } from "../composition/installation-graph.js";
import { GroupNode } from "../composition/group.js";
import { captureConfig } from "../composition/configuration.js";
import { normalizePlugin } from "../composition/plugin.js";
import { compileTransition, assertGroups, type CompositionState } from "../composition/planner.js";
import {
  PlanAuthority,
  describeBindings,
  type Plan,
  type PreparedTransition,
} from "../composition/plan.js";
import { Instance } from "./instance.js";
import type { ApplyResult, HostOptions } from "./host-api.js";
import type { ChangeSet, Group, Installation } from "../composition/declarations.js";
import type { HostStatus, InstallationState } from "../contracts/status.js";
import type { HostSnapshot, InstallationSnapshot } from "../inspection/diagnostics.js";
import type { Awaitable } from "../contracts/resource.js";

interface CommittedState extends CompositionState {
  readonly phase: "stopped" | "running" | "quarantined";
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
  readonly unresolved: ReadonlyArray<Instance>;
  readonly error: ErrorSnapshot | undefined;
}

interface Transition {
  readonly phase: "starting" | "changing" | "stopping";
  readonly affected: ReadonlySet<InstallationRecord>;
}

interface ExecutionScope {
  readonly graph: InstallationGraph;
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
}

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
  readonly #logger: Logger;
  readonly #onError: (error: unknown) => Awaitable<void>;
  readonly #shutdownTimeoutMs: number | undefined;
  readonly #contracts = new ContractRegistry();
  readonly #events = new EventHub();
  readonly #contributions: ContributionRegistry;
  readonly #commands = new SerialQueue();
  readonly #plans = new PlanAuthority();
  readonly #drafts = new WeakSet<ChangeSetDraft>();
  readonly #installations = new WeakMap<object, InstallationRecord>();
  readonly #groups = new WeakMap<object, GroupNode>();
  readonly #publisher: SnapshotPublisher<HostSnapshot>;
  #state: CommittedState;
  #transition: Transition | undefined;
  #sequence = 0;
  #generation = 0;

  constructor(options: HostOptions = {}) {
    const input = normalizePlainRecord(options, "Host options", {
      fields: new Set([
        "name",
        "installations",
        "groups",
        "logger",
        "onError",
        "shutdownTimeoutMs",
      ]),
    });
    assertId(input.name ?? "host", "Host name");
    this.name = (input.name ?? "host") as string;
    if (input.logger !== undefined && !isLogger(input.logger))
      throw new TypeError("Host logger is invalid");
    if (input.onError !== undefined && typeof input.onError !== "function")
      throw new TypeError("Host onError must be a function");
    if (
      input.shutdownTimeoutMs !== undefined &&
      (typeof input.shutdownTimeoutMs !== "number" ||
        !Number.isFinite(input.shutdownTimeoutMs) ||
        input.shutdownTimeoutMs <= 0)
    ) {
      throw new TypeError("Host shutdownTimeoutMs must be positive");
    }
    this.#logger = (input.logger ?? console) as Logger;
    this.#onError = (input.onError ?? ((error: unknown) => this.#logger.error(error))) as (
      error: unknown,
    ) => Awaitable<void>;
    this.#shutdownTimeoutMs = input.shutdownTimeoutMs as number | undefined;
    this.#contributions = new ContributionRegistry((error) => this.#report(error));
    const declarations = new Map<InstallationRecord, InstallationDeclaration>();
    const groups = new Map<string, GroupNode>();
    const initialGroups = input.groups ?? [];
    const initialInstallations = input.installations ?? [];
    if (!Array.isArray(initialGroups) || !Array.isArray(initialInstallations))
      throw new TypeError("Initial declarations must be arrays");
    const groupParents = new Map<string, string | undefined>();
    for (const raw of initialGroups) {
      const group = normalizePlainRecord(raw, "Initial Group", {
        fields: new Set(["id", "parentId"]),
      });
      assertId(group.id, "Group id");
      if (group.parentId !== undefined) assertId(group.parentId, "Parent Group id");
      if (groupParents.has(group.id))
        throw new DougongError("GROUP_CONFLICT", "Duplicate initial Group: " + group.id);
      groupParents.set(group.id, group.parentId as string | undefined);
    }
    const building = new Set<string>();
    const resolveGroup = (id: string): GroupNode => {
      const existing = groups.get(id);
      if (existing) return existing;
      if (!groupParents.has(id))
        throw new DougongError("GROUP_MISSING", "Initial Group is missing: " + id);
      if (building.has(id))
        throw new DougongError("GROUP_CYCLE", "Group ownership must be acyclic");
      building.add(id);
      const parentId = groupParents.get(id);
      const group = this.#createGroup(
        id,
        parentId === undefined ? undefined : resolveGroup(parentId),
      );
      groups.set(id, group);
      building.delete(id);
      return group;
    };
    for (const id of groupParents.keys()) resolveGroup(id);
    const ids = new Set<string>();
    for (const raw of initialInstallations) {
      const initial = normalizePlainRecord(raw, "Initial Installation", {
        fields: new Set(["id", "plugin", "config", "origin", "groupId"]),
      });
      assertId(initial.id, "Installation id");
      if (initial.groupId !== undefined) assertId(initial.groupId, "Installation Group id");
      if (ids.has(initial.id))
        throw new DougongError(
          "INSTALLATION_CONFLICT",
          "Duplicate initial Installation: " + initial.id,
        );
      ids.add(initial.id);
      const record = this.#createInstallation(
        initial.id,
        initial.groupId === undefined ? undefined : resolveGroup(initial.groupId as string),
      );
      declarations.set(
        record,
        Object.freeze({
          plugin: normalizePlugin(initial.plugin as never),
          config: captureConfig(initial.config),
          origin: captureOrigin(initial.origin),
        }),
      );
    }
    assertGroups(groups, declarations);
    this.#state = Object.freeze({
      revision: 0,
      declarations,
      groups,
      graph: InstallationGraph.build(declarations, this.#contracts.kinds),
      configs: new Map(),
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
    Object.freeze(this);
  }

  get status(): HostStatus {
    return this.#transition?.phase ?? this.#state.phase;
  }
  get stateRevision() {
    return this.#state.revision;
  }
  get diagnostics() {
    return this.#publisher.view;
  }

  installation(id: string): Installation | undefined {
    return [...this.#state.declarations.keys()].find((record) => record.id === id)?.facade;
  }

  group(id: string): Group | undefined {
    return this.#state.groups.get(id)?.facade;
  }

  explain(id: string) {
    return Object.freeze(
      describeBindings(this.#state.graph).filter((binding) => binding.installation === id),
    );
  }

  change(): ChangeSet {
    this.#assertHealthy();
    const draft = new ChangeSetDraft({
      create: (id, group) => this.#createInstallation(id, group),
      resolve: (handle) => this.#resolveInstallation(handle),
      createGroup: (id, parent) => this.#createGroup(id, parent),
      resolveGroup: (handle) => {
        const group = this.#groups.get(handle);
        if (!group) throw new DougongError("GROUP_FOREIGN", "Group belongs to another Host");
        return group;
      },
    });
    this.#drafts.add(draft);
    return draft;
  }

  async plan(change: ChangeSet): Promise<Plan> {
    this.#assertHealthy();
    if (!(change instanceof ChangeSetDraft) || !this.#drafts.has(change))
      throw new DougongError("CHANGE_FOREIGN", "ChangeSet belongs to another Host");
    this.#drafts.delete(change);
    const operations = change.take();
    try {
      return this.#plans.issue(
        await compileTransition(this.#state, operations, "change", this.#contracts.kinds),
      );
    } catch (error) {
      this.#discardPending(operations);
      throw error;
    }
  }

  apply(plan: Plan): Promise<ApplyResult> {
    if (this.#transition) return Promise.reject(this.#busyTransition());
    return this.#commands.run(() => this.#execute(plan));
  }

  start(): Promise<ApplyResult> {
    return this.#lifecycle("start");
  }
  stop(): Promise<ApplyResult> {
    return this.#lifecycle("stop");
  }

  async use<T, R>(
    requirement: Service<T> | OptionalService<T>,
    callback: (value: T | undefined) => Awaitable<R>,
  ): Promise<R> {
    if (typeof callback !== "function") throw new TypeError("Service callback must be a function");
    const normalized = normalizeRequirement(requirement);
    if (normalized.kind === "extensionPoint") throw new TypeError("Expected a Service");
    const token = normalized.kind === "optional" ? normalized.service : normalized;
    this.#contracts.assertCompatible(token);
    this.#assertHealthy();
    if (this.#state.phase !== "running")
      throw new DougongError("SERVICE_UNAVAILABLE", "Host is not running");
    const provider = this.#state.graph.provider(token.id);
    if (!provider) {
      if (normalized.kind === "optional") return callback(undefined);
      throw new DougongError("SERVICE_UNAVAILABLE", "No provider for " + token.id);
    }
    if (this.#transition?.affected.has(provider))
      throw new DougongError("SERVICE_UNAVAILABLE", "Service is changing: " + token.id);
    const instance = this.#state.instances.get(provider);
    if (!instance)
      throw new DougongError("SERVICE_UNAVAILABLE", "Service is not running: " + token.id);
    return instance.use<T, R>(token.id, callback);
  }

  contributions<T>(point: ExtensionPoint<T>) {
    const token = normalizeContract(point, "extensionPoint");
    this.#contracts.remember(token);
    return this.#contributions.view<T>(token);
  }

  #lifecycle(intent: "start" | "stop") {
    if (this.#transition) return Promise.reject(this.#busyTransition());
    return this.#commands.run(async () => {
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
          affected: new Set(this.#state.declarations.keys()),
        };
        this.#notify();
      }
      try {
        const prepared = await compileTransition(this.#state, [], intent, this.#contracts.kinds);
        return await this.#execute(this.#plans.issue(prepared));
      } finally {
        if (this.#transition) {
          this.#transition = undefined;
          this.#notify();
        }
      }
    });
  }

  async #execute(plan: Plan): Promise<ApplyResult> {
    this.#assertHealthy();
    const prepared = this.#plans.read(plan);
    if (prepared.baseStateRevision !== this.#state.revision) {
      this.#plans.consume(plan);
      for (const record of prepared.declarations.keys()) {
        if (!this.#state.declarations.has(record))
          record.detach({ status: "removed", origin: undefined });
      }
      throw new DougongError("PLAN_STALE", "Host state changed after planning", {
        details: {
          outcome: "rejected",
          expectedRevision: prepared.baseStateRevision,
          stateRevision: this.#state.revision,
        },
      });
    }
    if (prepared.intent === "change" && prepared.report.operations.length === 0) {
      this.#plans.consume(plan);
      return this.#result([]);
    }
    const previous = this.#state;
    const affectedInstances = previous.graph.order
      .filter((record) => prepared.affected.has(record))
      .flatMap((record) => previous.instances.get(record) ?? []);
    for (const instance of affectedInstances) {
      if (instance.lifetime.busy) {
        throw new DougongError("HOST_BUSY", "Affected work is still in flight", {
          details: {
            outcome: "rejected",
            installation: instance.installation.id,
            stateRevision: previous.revision,
          },
        });
      }
    }
    const writer = this.#contracts.writer(prepared.graph.contractKinds);
    for (const instance of affectedInstances) instance.lifetime.seal();
    this.#plans.consume(plan);
    this.#transition = {
      phase:
        prepared.intent === "start"
          ? "starting"
          : prepared.intent === "stop"
            ? "stopping"
            : "changing",
      affected: prepared.affected,
    };
    this.#notify();
    this.#contributions.beginBatch();
    try {
      if (previous.phase === "stopped" && prepared.intent !== "start") {
        writer.commit();
        this.#commit(prepared, new Map(), "stopped");
        return this.#result(prepared.report.affectedInstallations);
      }
      const stopErrors = await this.#dispose([previous], new Set(affectedInstances));
      if (
        stopErrors.length ||
        affectedInstances.some((instance) => instance.lifetime.phase !== "disposed")
      ) {
        writer.discard();
        throw await this.#quarantine(previous, [], stopErrors, prepared, "stop");
      }
      if (prepared.intent === "stop") {
        writer.commit();
        this.#commit(prepared, new Map(), "stopped");
        return this.#result(prepared.report.affectedInstallations);
      }
      const retained = new Map(previous.instances);
      for (const record of prepared.affected) retained.delete(record);
      const candidates = new Map<InstallationRecord, Instance>();
      const failures = new PreparationFailures((error) => this.#report(error));
      try {
        await this.#prepare(prepared, retained, candidates, writer, failures);
        for (const instance of candidates.values()) instance.lifetime.signal.throwIfAborted();
        failures.seal();
      } catch (error) {
        writer.discard();
        const scope: ExecutionScope = {
          graph: prepared.graph,
          instances: new Map([...retained, ...candidates]),
        };
        const cleanupErrors = await this.#dispose([scope], new Set(candidates.values()));
        const failure = failures.seal(error);
        if (
          cleanupErrors.length ||
          [...candidates.values()].some((instance) => instance.lifetime.phase !== "disposed")
        )
          throw await this.#quarantine(
            previous,
            [scope],
            [failure, ...cleanupErrors],
            prepared,
            "prepare",
          );
        if (previous.phase === "stopped") {
          this.#state = Object.freeze({
            ...previous,
            revision: previous.revision + 1,
            error: new RecordedFailure(failure).snapshot,
          });
          throw this.#transitionError(
            "TRANSITION_FAILED",
            "Startup failed",
            failure,
            "restored",
            prepared,
            "prepare",
          );
        }
        await this.#restore(previous, retained, prepared, failure);
        throw this.#transitionError(
          "TRANSITION_FAILED",
          "Change failed; previous declarations were restored",
          failure,
          "restored",
          prepared,
          "prepare",
        );
      }
      for (const [record, instance] of candidates) retained.set(record, instance);
      try {
        writer.commit();
        this.#commit(prepared, retained, "running", candidates);
      } catch (error) {
        writer.discard();
        throw await this.#quarantine(
          this.#state,
          [{ graph: prepared.graph, instances: new Map(retained) }],
          [error],
          prepared,
          "publish",
        );
      }
      return this.#result(prepared.report.affectedInstallations);
    } finally {
      this.#transition = undefined;
      for (const record of prepared.declarations.keys()) {
        if (!this.#state.declarations.has(record))
          record.detach({ status: "removed", origin: undefined });
      }
      batchSnapshotNotifications(() => {
        this.#contributions.endBatch();
        this.#notify();
      });
    }
  }

  async #prepare(
    prepared: Pick<PreparedTransition, "graph" | "affected" | "configs">,
    retained: ReadonlyMap<InstallationRecord, Instance>,
    candidates: Map<InstallationRecord, Instance>,
    writer: ReturnType<ContractRegistry["writer"]>,
    failures: PreparationFailures,
  ) {
    const startup = new AbortController();
    const generation = ++this.#generation;
    for (const layer of prepared.graph.layers) {
      const instances = layer
        .filter((record) => prepared.affected.has(record))
        .map((record) => {
          const instance = new Instance(record, prepared.graph.declarationFor(record), generation, {
            hostName: this.name,
            logger: this.#logger,
            report: (error) => this.#report(error),
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
            shutdownTimeoutMs: this.#shutdownTimeoutMs,
          });
          candidates.set(record, instance);
          return instance;
        });
      try {
        await Promise.all(
          instances.map(async (instance) => {
            const deps: Record<string, unknown> = Object.create(null);
            for (const [alias, requirement] of Object.entries(
              instance.declaration.plugin.requires,
            )) {
              if (requirement.kind === "extensionPoint") {
                deps[alias] = this.#contributions.view(requirement, instance.lifetime);
                continue;
              }
              const token = requirement.kind === "optional" ? requirement.service : requirement;
              const provider = prepared.graph.providerFor(instance.installation, token.id);
              deps[alias] = provider
                ? (candidates.get(provider) ?? retained.get(provider))?.read(token.id)
                : undefined;
            }
            try {
              await instance.prepare(
                Object.freeze(deps),
                prepared.configs.get(instance.installation)?.value,
              );
            } catch (error) {
              if (!startup.signal.aborted || !Object.is(error, startup.signal.reason))
                failures.add(error);
              startup.abort(error);
              throw error;
            }
          }),
        );
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
    const candidates = new Map<InstallationRecord, Instance>();
    const failures = new PreparationFailures((error) => this.#report(error));
    const writer = this.#contracts.writer(previous.graph.contractKinds);
    try {
      await this.#prepare(
        { graph: previous.graph, affected: failed.affected, configs: previous.configs },
        retained,
        candidates,
        writer,
        failures,
      );
      for (const instance of candidates.values()) instance.lifetime.signal.throwIfAborted();
      failures.seal();
      for (const [record, instance] of candidates) retained.set(record, instance);
      writer.commit();
      this.#state = Object.freeze({
        ...previous,
        revision: previous.revision + 1,
        instances: retained,
        error: new RecordedFailure(error).snapshot,
      });
      for (const instance of candidates.values()) instance.publish();
    } catch (restoreError) {
      writer.discard();
      const scope: ExecutionScope = {
        graph: previous.graph,
        instances: new Map([...retained, ...candidates]),
      };
      const cleanupErrors = await this.#dispose([scope], new Set(candidates.values()));
      throw await this.#quarantine(
        previous,
        [scope],
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
    candidates: ReadonlyMap<InstallationRecord, Instance> = new Map(),
  ) {
    const previous = this.#state;
    this.#state = Object.freeze({
      revision: previous.revision + 1,
      declarations: prepared.declarations,
      groups: prepared.groups,
      graph: prepared.graph,
      configs: prepared.configs,
      phase,
      instances,
      unresolved: Object.freeze([]),
      error: undefined,
    });
    for (const record of previous.declarations.keys()) {
      if (!prepared.declarations.has(record))
        record.detach({ status: "removed", origin: undefined });
    }
    for (const instance of candidates.values()) instance.publish();
  }

  async #quarantine(
    previous: CommittedState,
    scopes: ReadonlyArray<ExecutionScope>,
    errors: ReadonlyArray<unknown>,
    prepared: PreparedTransition,
    phase: string,
  ) {
    const execution = [previous, ...scopes];
    const owned = new Set(execution.flatMap((scope) => [...scope.instances.values()]));
    const remaining = [...owned].filter((instance) => instance.lifetime.phase !== "disposed");
    for (const instance of remaining) instance.lifetime.block();
    if (this.#transition) {
      this.#transition = {
        ...this.#transition,
        affected: new Set([
          ...this.#transition.affected,
          ...remaining.map((instance) => instance.installation),
        ]),
      };
    }
    const cleanupErrors = await this.#dispose(execution, new Set(remaining));
    const unresolved = remaining.filter((instance) => instance.lifetime.phase !== "disposed");
    const cause = new AggregateError(
      [...errors, ...cleanupErrors],
      "Execution could not establish a healthy state",
    );
    this.#state = Object.freeze({
      ...previous,
      revision: this.#state.revision + 1,
      phase: "quarantined",
      instances: new Map(),
      unresolved: Object.freeze(unresolved),
      error: new RecordedFailure(cause).snapshot,
    });
    return this.#transitionError(
      "HOST_QUARANTINED",
      "Host is quarantined after execution could not establish a healthy state",
      cause,
      "quarantined",
      prepared,
      phase,
    );
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

    const errors: unknown[] = [];
    const visited = new Set<Instance>();
    const dispose = async (instance: Instance): Promise<void> => {
      if (visited.has(instance)) return;
      visited.add(instance);
      const consumers = dependents.get(instance) ?? [];
      for (const consumer of consumers) {
        if (targets.has(consumer)) await dispose(consumer);
      }
      // Bindings belong to each execution generation, not the latest installation declaration.
      // A failed or busy consumer only retains the providers it can still reach.
      if (
        [...consumers].some((consumer) => consumer.lifetime.phase !== "disposed") ||
        instance.lifetime.busy ||
        instance.lifetime.phase === "disposed" ||
        instance.lifetime.phase === "quarantined"
      )
        return;
      try {
        await instance.dispose();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const instance of [...targets].reverse()) await dispose(instance);
    return errors;
  }

  #transitionError(
    code: string,
    message: string,
    cause: unknown,
    outcome: "restored" | "quarantined",
    prepared: PreparedTransition,
    phase: string,
  ) {
    return new DougongError(code, message, {
      cause,
      details: {
        outcome,
        phase,
        stateRevision: this.#state.revision,
        affectedInstallations: prepared.report.affectedInstallations,
      },
    });
  }

  #result(affectedInstallations: ReadonlyArray<string>): ApplyResult {
    return Object.freeze({
      stateRevision: this.#state.revision,
      affectedInstallations: Object.freeze([...affectedInstallations]),
    });
  }

  #assertHealthy() {
    if (this.#state.phase === "quarantined")
      throw new DougongError("HOST_QUARANTINED", "Host execution is permanently quarantined", {
        details: { outcome: "quarantined", stateRevision: this.#state.revision },
      });
  }

  #busyTransition() {
    return new DougongError("HOST_BUSY", "Another Host transition is in progress", {
      details: { outcome: "rejected", stateRevision: this.#state.revision },
    });
  }

  #createInstallation(id: string, group: GroupNode | undefined) {
    const record = new InstallationRecord(id, ++this.#sequence, group);
    this.#installations.set(record.facade, record);
    record.attach(() => ({
      status: this.#installationStatus(record),
      origin: this.#state.declarations.get(record)?.origin,
    }));
    return record;
  }

  #createGroup(id: string, parent: GroupNode | undefined) {
    const group = new GroupNode(id, parent);
    this.#groups.set(group.facade, group);
    return group;
  }

  #resolveInstallation(handle: object) {
    const record = this.#installations.get(handle);
    if (!record)
      throw new DougongError("INSTALLATION_FOREIGN", "Installation belongs to another Host");
    return record;
  }

  #discardPending(operations: ReadonlyArray<ChangeOperation>) {
    for (const operation of operations) {
      if (operation.kind === "install" && !this.#state.declarations.has(operation.installation)) {
        operation.installation.detach({ status: "removed", origin: undefined });
      }
    }
  }

  #installationStatus(record: InstallationRecord): InstallationState {
    if (!this.#state.declarations.has(record)) return "pending";
    if (this.#state.phase === "quarantined") return "quarantined";
    if (this.#transition?.affected.has(record)) return "changing";
    return this.#state.instances.has(record) ? "running" : "stopped";
  }

  #snapshot(): HostSnapshot {
    const installations: InstallationSnapshot[] = [...this.#state.declarations].map(
      ([record, declaration]) => {
        const instance = this.#state.instances.get(record);
        return Object.freeze({
          id: record.id,
          groupId: record.groupId,
          pluginName: declaration.plugin.name,
          status: this.#installationStatus(record),
          origin: declaration.origin,
          generation: instance?.generation,
          requires: Object.freeze(
            Object.values(declaration.plugin.requires).map((token) =>
              token.kind === "optional" ? token.service.id : token.id,
            ),
          ),
          provides: Object.freeze(
            Object.values(declaration.plugin.provides).map((token) => token.id),
          ),
          lifetime: instance?.lifetime.snapshot(),
        });
      },
    );
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
              installations
                .filter((installation) => installation.groupId === group.id)
                .map((installation) => installation.id),
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
    try {
      this.#publisher.invalidate();
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown) {
    const logger = this.#logger;
    const fallback = (failure: unknown) => {
      try {
        void Promise.resolve(
          logger.error(new AggregateError([error, failure], "Host error reporter failed")),
        ).catch(() => undefined);
      } catch {
        // There is no lower reporting boundary; observer errors must not rewrite a committed outcome.
      }
    };
    try {
      void Promise.resolve(this.#onError(error)).catch(fallback);
    } catch (failure) {
      fallback(failure);
    }
  }
}
