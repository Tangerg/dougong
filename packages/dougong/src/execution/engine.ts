import { shutdownTimeout } from "../lifetime/lifetime.js";
import { ContractRegistry } from "../contracts/contract-registry.js";
import {
  DougongError,
  quarantinedHost,
  RecordedFailure,
  type ErrorSnapshot,
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
import { SerialQueue } from "../internal/serial-queue.js";
import { captureDataArray } from "../internal/data-array.js";
import { normalizePlainRecord } from "../internal/record.js";
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
  readonly #drafts = new ChangeSets();
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
    const name = input.name === undefined ? "host" : input.name;
    assertId(name, "Host name");
    this.name = name;
    if (input.onError !== undefined && typeof input.onError !== "function")
      throw new TypeError("Host onError must be a function");

    this.#logger = captureLogger(input.logger === undefined ? console : input.logger);
    this.#onError = (input.onError ?? ((error: unknown) => this.#logger.error(error))) as (
      error: unknown,
    ) => Awaitable<void>;
    this.#shutdownTimeoutMs = shutdownTimeout(input.shutdownTimeoutMs);
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
        fields: new Set(["id", "parentId"]),
      });
      assertId(group.id, "Group id");
      if (group.parentId !== undefined) assertId(group.parentId, "Parent Group id");
      if (groupParents.has(group.id))
        throw new DougongError("GROUP_CONFLICT", "Duplicate initial Group: " + group.id);
      groupParents.set(group.id, group.parentId as string | undefined);
    }
    const groups = buildInitialGroups(groupParents, (id, parent) => this.#createGroup(id, parent));
    const ids = new Set<string>();
    for (const raw of initialInstallations) {
      const initial = normalizePlainRecord(raw, "Initial Installation", {
        fields: new Set(["id", "plugin", "config", "origin", "groupId"]),
      });
      assertId(initial.id, "Installation id");
      if (initial.groupId !== undefined) assertId(initial.groupId, "Installation Group id");
      claimInstallationId(ids, initial.id);
      const group =
        initial.groupId === undefined ? undefined : groups.get(initial.groupId as string);
      if (initial.groupId !== undefined && !group)
        throw new DougongError("GROUP_MISSING", "Initial Group is missing: " + initial.groupId);
      const record = this.#createInstallation(initial.id, group);
      declarations.set(
        record,
        captureInstallationDeclaration(initial.plugin, initial.config, initial.origin),
      );
    }
    this.#state = Object.freeze({
      revision: 0,
      groups,
      graph: InstallationGraph.build(declarations),
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
    for (const record of declarations.keys()) this.#attachInstallation(record);
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
    return this.#state.graph.byId.get(id)?.facade;
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
    return this.#drafts.create({
      create: (id, group) => this.#createInstallation(id, group),
      resolve: (handle) => this.#resolveInstallation(handle),
      createGroup: (id, parent) => this.#createGroup(id, parent),
      resolveGroup: (handle) => {
        const group = this.#groups.get(handle);
        if (!group) throw new DougongError("GROUP_FOREIGN", "Group belongs to another Host");
        return group;
      },
    });
  }

  async plan(change: ChangeSet): Promise<Plan> {
    this.#assertHealthy();
    const operations = this.#drafts.take(change);
    const validity = this.#plans.validationSignal;
    try {
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

  use<T, R>(
    requirement: Service<T> | OptionalService<T>,
    callback: (value: T | undefined) => Awaitable<R>,
  ): Promise<R> {
    try {
      if (typeof callback !== "function")
        throw new TypeError("Service callback must be a function");
      const normalized = normalizeRequirement(requirement);
      if (normalized.kind === "extensionPoint") throw new TypeError("Expected a Service");
      const token = normalized.kind === "optional" ? normalized.service : normalized;
      this.#contracts.assertCompatible(token);
      this.#assertHealthy();
      if (this.#state.phase !== "running")
        throw new DougongError("SERVICE_UNAVAILABLE", "Host is not running");
      const provider = this.#state.graph.providers.get(token.id);
      if (!provider) {
        if (normalized.kind === "optional") return Promise.resolve(callback(undefined));
        throw new DougongError("SERVICE_UNAVAILABLE", "No provider for " + token.id);
      }
      if (this.#transition?.affected.has(provider))
        throw new DougongError("SERVICE_UNAVAILABLE", "Service is changing: " + token.id);
      const instance = this.#state.instances.get(provider);
      if (!instance)
        throw new DougongError("SERVICE_UNAVAILABLE", "Service is not running: " + token.id);
      return instance.use<T, R>(token.id, callback);
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
          affected: new Set(this.#state.graph.declarations.keys()),
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
    });
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
        throw new DougongError("HOST_BUSY", "Affected work is still in flight", {
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
    this.#transition = {
      phase:
        prepared.report.intent === "start"
          ? "starting"
          : prepared.report.intent === "stop"
            ? "stopping"
            : "changing",
      affected: prepared.affected,
    };
    // Diagnostics observers may register new contributions synchronously at transition ingress.
    this.#contributions.beginBatch();
    this.#notify();
    try {
      if (previous.phase === "stopped" && prepared.report.intent !== "start") {
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
      if (prepared.report.intent === "stop") {
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
        for (const instance of candidates.values())
          AbortSignal.prototype.throwIfAborted.call(instance.lifetime.signal);
        // A concurrent durable claim can still reject this candidate without publishing anything.
        writer.commit();
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
          this.#advance({
            ...previous,
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
      this.#detachUncommitted(prepared.graph.declarations.keys());
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
              const provider = prepared.graph.providers.get(token.id);
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
      for (const instance of candidates.values())
        AbortSignal.prototype.throwIfAborted.call(instance.lifetime.signal);
      failures.seal();
      for (const [record, instance] of candidates) retained.set(record, instance);
      writer.commit();
      this.#advance({
        ...previous,
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
    this.#advance({
      groups: prepared.groups,
      graph: prepared.graph,
      configs: prepared.configs,
      phase,
      instances,
      unresolved: Object.freeze([]),
      error: undefined,
    });
    for (const record of prepared.graph.declarations.keys()) {
      if (!previous.graph.declarations.has(record)) this.#attachInstallation(record);
    }
    for (const record of previous.graph.declarations.keys()) {
      if (!prepared.graph.declarations.has(record))
        record.detach({ status: "removed", origin: undefined });
    }
    for (const instance of candidates.values()) instance.publish();
  }

  #advance(next: Omit<CommittedState, "revision">) {
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
    this.#advance({
      ...previous,
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
    if (this.#state.phase === "quarantined") throw quarantinedHost(this.#state.revision);
  }

  #busyTransition() {
    return new DougongError("HOST_BUSY", "Another Host transition is in progress", {
      details: { outcome: "rejected", stateRevision: this.#state.revision },
    });
  }

  #createInstallation(id: string, group: GroupNode | undefined) {
    const record = new InstallationRecord(id, ++this.#sequence, group);
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
      throw new DougongError("INSTALLATION_FOREIGN", "Installation belongs to another Host");
    return record;
  }

  #discardPending(operations: ReadonlyArray<ChangeOperation>) {
    this.#detachUncommitted(
      operations.flatMap((op) => (op.kind === "install" ? [op.installation] : [])),
    );
  }

  #installationStatus(record: InstallationRecord): InstallationState {
    if (!this.#state.graph.declarations.has(record)) return "pending";
    if (this.#state.phase === "quarantined") return "quarantined";
    if (this.#transition?.affected.has(record)) return "changing";
    return this.#state.instances.has(record) ? "running" : "stopped";
  }

  #snapshot(): HostSnapshot {
    const installations: InstallationSnapshot[] = [...this.#state.graph.declarations].map(
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
      const report = this.#onError;
      void Promise.resolve(report(error)).catch(fallback);
    } catch (failure) {
      fallback(failure);
    }
  }
}
