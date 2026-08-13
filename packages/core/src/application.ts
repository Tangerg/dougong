import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ContractKind, Event, Extension, Service } from "./contracts";
import { ConfigValidationError, DougongError, type ValidationIssue } from "./errors";
import { EventHub, type EventListener } from "./event-hub";
import { ExtensionStore, type Contribution, type ExtensionView } from "./extension-store";
import { Lifetime, type LifetimeHost, type Logger, type PluginMeta } from "./lifetime";
import type { PluginContext, PluginDefinition, Provisions, Requirements } from "./plugin";

export type PluginStatus = "pending" | "active" | "stopping" | "failed" | "removed";
export type ApplicationStatus = "idle" | "starting" | "active" | "stopping";

export interface PluginUpdate<
  Config,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> {
  readonly plugin?: PluginDefinition<Config, Requires, Provides, ConfigInput>;
  readonly config?: ConfigInput;
}

export interface PluginHandle<
  Config = unknown,
  Requires extends Requirements = Requirements,
  Provides extends Provisions = Provisions,
  ConfigInput = Config,
> {
  readonly id: string;
  readonly status: PluginStatus;
  ready(): Promise<void>;
  update(update: PluginUpdate<Config, Requires, Provides, ConfigInput>): Promise<void>;
  remove(): Promise<void>;
}

export interface CreateAppOptions {
  readonly name?: string;
  readonly logger?: Logger;
}

export interface Application {
  readonly name: string;
  readonly log: Logger;
  readonly status: ApplicationStatus;
  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type AnyPlugin = PluginDefinition<unknown, Requirements, Provisions, unknown>;

interface InstallationSpec {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
}

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
  readonly lifetime: Lifetime;
}

interface ServiceBinding {
  readonly provider: PluginRecord;
  readonly value: unknown;
}

interface Provider {
  readonly record: PluginRecord;
  readonly alias: string;
  readonly token: Service<unknown>;
}

interface StartPlan {
  readonly order: PluginRecord[];
  readonly providers: ReadonlyMap<string, Provider>;
  readonly dependents: ReadonlyMap<PluginRecord, ReadonlySet<PluginRecord>>;
  readonly contractKinds: ReadonlyMap<string, ContractKind>;
}

interface RecordSnapshot {
  readonly id: string;
  readonly record: PluginRecord;
  readonly spec: InstallationSpec;
  readonly resolvedConfig: unknown;
}

class IncompletePluginCleanupError extends AggregateError {}

const defaultLogger: Logger = console;

function installation(plugin: AnyPlugin, config: unknown): InstallationSpec {
  return Object.freeze({ plugin, config });
}

class PluginRecord {
  status: PluginStatus = "pending";
  runtime: PluginRuntime | undefined;
  error?: unknown;

  readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();

  constructor(
    readonly id: string,
    readonly index: number,
    public spec: InstallationSpec,
  ) {}

  ready() {
    if (this.status === "active") return Promise.resolve();
    if (this.status === "failed" || this.status === "removed") {
      return Promise.reject(
        this.error ??
          new DougongError("PLUGIN_UNAVAILABLE", `Plugin '${this.id}' is ${this.status}`),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }

  activate(runtime: PluginRuntime) {
    this.runtime = runtime;
    this.status = "active";
    this.error = undefined;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  pending() {
    this.runtime = undefined;
    this.status = "pending";
    this.error = undefined;
  }

  fail(error: unknown) {
    this.runtime = undefined;
    this.status = "failed";
    this.error = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  remove() {
    const error = new DougongError("PLUGIN_REMOVED", `Plugin '${this.id}' has been removed`);
    this.runtime = undefined;
    this.status = "removed";
    this.error = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}

class PluginHandleImpl<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
> implements PluginHandle<Config, Requires, Provides, ConfigInput> {
  constructor(
    readonly record: PluginRecord,
    readonly updateRecord: (
      update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
    ) => Promise<void>,
    readonly removeRecord: () => Promise<void>,
  ) {}

  get id() {
    return this.record.id;
  }

  get status() {
    return this.record.status;
  }

  ready() {
    return this.record.ready();
  }

  update(update: PluginUpdate<Config, Requires, Provides, ConfigInput>) {
    return this.updateRecord(update);
  }

  remove() {
    return this.removeRecord();
  }
}

class ApplicationImpl implements Application {
  readonly name: string;
  readonly log: Logger;

  readonly #records = new Map<string, PluginRecord>();
  readonly #services = new Map<string, ServiceBinding>();
  readonly #extensionStores = new Map<string, ExtensionStore<unknown>>();
  readonly #contractKinds = new Map<string, ContractKind>();
  readonly #events = new EventHub();
  readonly #host: LifetimeHost;

  #counter = 0;
  #status: ApplicationStatus = "idle";
  #startOrder: PluginRecord[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(options: CreateAppOptions = {}) {
    const name = options.name ?? "app";
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Application name must be a non-empty string");
    }
    if (name !== name.trim()) {
      throw new TypeError("Application name cannot start or end with whitespace");
    }
    this.name = name;
    this.log = options.logger ?? defaultLogger;
    this.#host = {
      log: this.log,
      on: (token, listener) => this.#on(token, listener),
      emit: (token, payload) => this.#emit(token, payload),
      contribute: (ownerId, token, key, value) => {
        return this.#contribute(ownerId, token, key, value);
      },
      report: (error) => this.log.error(error),
    };
  }

  get status() {
    return this.#status;
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput> {
    const index = ++this.#counter;
    const id = `${plugin.name}:${index}`;
    const record = new PluginRecord(
      id,
      index,
      installation(plugin as unknown as AnyPlugin, config[0]),
    );
    const handle = new PluginHandleImpl<Config, Requires, Provides, ConfigInput>(
      record,
      (update) => this.#updateRecord(record, update),
      () => this.#removeRecord(record),
    );

    const operation = this.#enqueue(async () => {
      const change = () => this.#records.set(id, record);
      if (this.#status === "active") {
        await this.#transact(new Set([record]), change);
      } else {
        change();
      }
    });
    operation.catch((error) => record.fail(error));
    return handle;
  }

  start() {
    return this.#enqueue(async () => {
      if (this.#status === "active") return;

      this.#status = "starting";
      try {
        await this.#startPlan(this.#buildPlan());
        this.#status = "active";
      } catch (error) {
        this.#status = "idle";
        for (const record of this.#records.values()) {
          if (record.status !== "active") record.fail(error);
        }
        throw error;
      }
    });
  }

  stop() {
    return this.#enqueue(async () => {
      if (this.#status === "idle") return;

      this.#status = "stopping";
      const errors = await this.#stopRecords(new Set(this.#startOrder));
      this.#status = "idle";

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Application shutdown failed");
      }
    });
  }

  #updateRecord<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    record: PluginRecord,
    update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
  ) {
    const change = () => {
      if (this.#records.get(record.id) !== record) {
        throw new DougongError("PLUGIN_REMOVED", `Plugin '${record.id}' has been removed`);
      }

      const plugin = update.plugin ? (update.plugin as AnyPlugin) : record.spec.plugin;
      const config = Object.hasOwn(update, "config") ? update.config : record.spec.config;
      record.spec = installation(plugin, config);
    };

    return this.#enqueue(async () => {
      if (this.#status === "active") {
        await this.#transact(new Set([record]), change);
      } else {
        change();
        record.pending();
      }
    });
  }

  #removeRecord(record: PluginRecord) {
    const change = () => {
      if (this.#records.get(record.id) !== record) return;
      this.#records.delete(record.id);
    };

    return this.#enqueue(async () => {
      if (this.#status === "active") {
        await this.#transact(new Set([record]), change);
      } else {
        change();
      }
      record.remove();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #transact(changed: ReadonlySet<PluginRecord>, change: () => void) {
    const snapshot = this.#snapshot();
    const previousPlan = this.#buildPlan();

    let nextPlan: StartPlan;
    let affected: ReadonlySet<PluginRecord>;
    let nextConfigs: ReadonlyMap<PluginRecord, unknown>;

    try {
      change();
      nextPlan = this.#buildPlan();
      affected = this.#affectedRecords(previousPlan, nextPlan, changed);
      nextConfigs = await this.#resolveConfigs(
        nextPlan.order.filter((record) => affected.has(record)),
      );
      this.#commitContractKinds(nextPlan.contractKinds);
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }

    const previousConfigs = new Map<PluginRecord, unknown>();
    for (const item of snapshot) {
      if (affected.has(item.record)) {
        previousConfigs.set(item.record, item.resolvedConfig);
      }
    }

    const stopErrors = await this.#stopRecords(affected);
    if (stopErrors.length) {
      return this.#failClosed(
        snapshot,
        stopErrors,
        "Plugin change could not cleanly stop the affected runtime",
      );
    }

    try {
      await this.#startRecords(nextPlan, affected, nextConfigs);
      this.#startOrder = nextPlan.order.slice();
      this.#status = "active";
    } catch (changeError) {
      const nextStopErrors = await this.#stopRecords(affected);
      if (changeError instanceof IncompletePluginCleanupError || nextStopErrors.length) {
        return this.#failClosed(
          snapshot,
          [changeError, ...nextStopErrors],
          "Plugin change failed and its partial runtime could not be cleanly disposed",
        );
      }
      return this.#rollback(snapshot, previousPlan, affected, previousConfigs, [
        changeError,
        ...nextStopErrors,
      ]);
    }
  }

  async #failClosed(
    snapshot: ReadonlyArray<RecordSnapshot>,
    causes: ReadonlyArray<unknown>,
    message: string,
  ): Promise<never> {
    this.#restore(snapshot);
    const shutdownErrors = await this.#stopRecords(new Set(this.#startOrder));
    this.#status = "idle";
    throw new AggregateError([...causes, ...shutdownErrors], message);
  }

  async #rollback(
    snapshot: ReadonlyArray<RecordSnapshot>,
    previousPlan: StartPlan,
    affected: ReadonlySet<PluginRecord>,
    previousConfigs: ReadonlyMap<PluginRecord, unknown>,
    causes: ReadonlyArray<unknown>,
  ): Promise<never> {
    this.#restore(snapshot);

    try {
      await this.#startRecords(previousPlan, affected, previousConfigs);
      this.#startOrder = previousPlan.order.slice();
      this.#status = "active";
    } catch (rollbackError) {
      const shutdownErrors = await this.#stopRecords(new Set(this.#startOrder));
      this.#status = "idle";
      throw new AggregateError(
        [...causes, rollbackError, ...shutdownErrors],
        "Plugin change failed and the previous application could not be restored",
      );
    }

    if (causes.length === 1) throw causes[0];
    throw new AggregateError(causes, "Plugin change failed");
  }

  #snapshot(): RecordSnapshot[] {
    return [...this.#records].map(([id, record]) => ({
      id,
      record,
      spec: record.spec,
      resolvedConfig: record.runtime?.config,
    }));
  }

  #restore(snapshot: ReadonlyArray<RecordSnapshot>) {
    this.#records.clear();
    for (const item of snapshot) {
      item.record.spec = item.spec;
      this.#records.set(item.id, item.record);
    }
  }

  #affectedRecords(
    previousPlan: StartPlan,
    nextPlan: StartPlan,
    changed: ReadonlySet<PluginRecord>,
  ) {
    const affected = new Set<PluginRecord>();

    const expand = (plan: StartPlan) => {
      const queue = [...changed];
      const visited = new Set<PluginRecord>();
      while (queue.length) {
        const record = queue.shift()!;
        if (visited.has(record)) continue;
        visited.add(record);
        affected.add(record);

        for (const dependent of plan.dependents.get(record) ?? []) {
          queue.push(dependent);
        }
      }
    };

    expand(previousPlan);
    expand(nextPlan);
    return affected;
  }

  #buildPlan(): StartPlan {
    const records = [...this.#records.values()].sort((left, right) => left.index - right.index);
    const providers = new Map<string, Provider>();
    const dependents = new Map<PluginRecord, Set<PluginRecord>>();
    const indegree = new Map(records.map((record) => [record, 0]));
    const contractKinds = new Map(this.#contractKinds);

    for (const record of records) {
      for (const [alias, token] of Object.entries(record.spec.plugin.provides ?? {})) {
        this.#validateContract(contractKinds, token);
        const previous = providers.get(token.id);
        if (previous) {
          throw new DougongError(
            "SERVICE_CONFLICT",
            `Service '${token.id}' is provided by both '${previous.record.id}' and '${record.id}'`,
          );
        }
        providers.set(token.id, { record, alias, token });
      }
    }

    for (const record of records) {
      for (const requirement of Object.values(record.spec.plugin.requires ?? {})) {
        const token = requirement.kind === "optional" ? requirement.service : requirement;
        this.#validateContract(contractKinds, token);
        if (token.kind === "extension") continue;

        const provider = providers.get(token.id);
        if (!provider) {
          if (requirement.kind === "optional") continue;
          throw new DougongError(
            "SERVICE_MISSING",
            `Plugin '${record.id}' requires missing service '${token.id}'`,
          );
        }

        if (provider.record === record) {
          throw new DougongError(
            "SERVICE_CYCLE",
            `Plugin '${record.id}' cannot require service '${token.id}' that it provides`,
          );
        }

        const targets = dependents.get(provider.record) ?? new Set();
        if (targets.has(record)) continue;
        targets.add(record);
        dependents.set(provider.record, targets);
        indegree.set(record, (indegree.get(record) ?? 0) + 1);
      }
    }

    const queue = records.filter((record) => indegree.get(record) === 0);
    const order: PluginRecord[] = [];

    while (queue.length) {
      queue.sort((left, right) => left.index - right.index);
      const record = queue.shift()!;
      order.push(record);

      for (const dependent of dependents.get(record) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (!next) queue.push(dependent);
      }
    }

    if (order.length !== records.length) {
      const cycle = records.filter((record) => !order.includes(record)).map((record) => record.id);
      throw new DougongError("SERVICE_CYCLE", `Plugin dependency cycle: ${cycle.join(" -> ")}`);
    }

    return { order, providers, dependents, contractKinds };
  }

  async #startPlan(plan: StartPlan) {
    const records = new Set(plan.order);
    const configs = await this.#resolveConfigs(plan.order);
    this.#commitContractKinds(plan.contractKinds);
    this.#services.clear();
    this.#startOrder = [];

    try {
      await this.#startRecords(plan, records, configs);
      this.#startOrder = plan.order.slice();
    } catch (error) {
      const cleanupErrors = await this.#stopRecords(records);
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Application startup failed");
      }
      throw error;
    }
  }

  async #startRecords(
    plan: StartPlan,
    records: ReadonlySet<PluginRecord>,
    configs: ReadonlyMap<PluginRecord, unknown>,
  ) {
    for (const record of plan.order) {
      if (!records.has(record) || record.runtime) continue;

      const config = configs.has(record)
        ? configs.get(record)
        : await this.#resolveConfig(record.spec.plugin.config, record.spec.config);
      await this.#startRecord(record, config);
      this.#startOrder.push(record);
    }
  }

  async #startRecord(record: PluginRecord, config: unknown) {
    record.pending();
    const plugin = record.spec.plugin;
    const lifetime = new Lifetime(this.#host, record.id);

    try {
      const requirements = this.#resolveRequirements(record, plugin);
      const meta: PluginMeta = {
        app: this.name,
        name: plugin.name,
        instance: record.id,
      };
      const context = this.#createContext(lifetime, meta, requirements);
      const output = await plugin.setup(context, config);
      const services = new Map<string, unknown>();

      for (const [alias, token] of Object.entries(plugin.provides ?? {})) {
        if (typeof output !== "object" || output === null || !Object.hasOwn(output, alias)) {
          throw new DougongError(
            "SERVICE_NOT_RETURNED",
            `Plugin '${record.id}' did not return provided service '${alias}'`,
          );
        }
        services.set(token.id, (output as Record<string, unknown>)[alias]);
      }

      for (const [id, value] of services) {
        this.#services.set(id, { provider: record, value });
      }
      record.activate({ plugin, config, lifetime });
    } catch (error) {
      record.fail(error);
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        throw new IncompletePluginCleanupError(
          [error, cleanupError],
          `Plugin '${record.id}' failed to start and could not be cleanly disposed`,
        );
      }
      throw error;
    }
  }

  async #stopRecords(records: ReadonlySet<PluginRecord>) {
    const errors: unknown[] = [];
    const order = this.#startOrder.filter((record) => records.has(record)).reverse();
    this.#startOrder = this.#startOrder.filter((record) => !records.has(record));

    for (const record of order) {
      const runtime = record.runtime;
      if (!runtime) continue;

      record.status = "stopping";
      try {
        await runtime.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        for (const token of Object.values(runtime.plugin.provides ?? {})) {
          const binding = this.#services.get(token.id);
          if (binding?.provider === record) this.#services.delete(token.id);
        }
        record.pending();
      }
    }

    return errors;
  }

  async #resolveConfigs(records: ReadonlyArray<PluginRecord>) {
    const configs = new Map<PluginRecord, unknown>();
    for (const record of records) {
      configs.set(record, await this.#resolveConfig(record.spec.plugin.config, record.spec.config));
    }
    return configs;
  }

  #resolveRequirements(record: PluginRecord, plugin: AnyPlugin): Record<string, unknown> {
    const values: Record<string, unknown> = Object.create(null);

    for (const [alias, requirement] of Object.entries(plugin.requires ?? {})) {
      if (requirement.kind === "optional") {
        values[alias] = this.#services.get(requirement.service.id)?.value;
      } else if (requirement.kind === "service") {
        const binding = this.#services.get(requirement.id);
        if (!binding) {
          throw new DougongError(
            "SERVICE_UNAVAILABLE",
            `Service '${requirement.id}' is not active for plugin '${record.id}'`,
          );
        }
        values[alias] = binding.value;
      } else {
        values[alias] = this.#extensionStore(requirement);
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
      signal: lifetime.signal,
      meta,
      log: this.log,
      cleanup: lifetime.cleanup.bind(lifetime),
      lifetime: lifetime.lifetime.bind(lifetime),
      spawn: lifetime.spawn.bind(lifetime),
      observe: lifetime.observe.bind(lifetime),
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

  #on<T>(token: Event<T>, listener: EventListener<T>) {
    this.#rememberContract(token);
    return this.#events.on(token.id, listener);
  }

  #emit<T>(token: Event<T>, payload: T) {
    this.#rememberContract(token);
    return this.#events.emit(token.id, payload);
  }

  #contribute<T>(ownerId: string, token: Extension<T>, key: string, value: T): Contribution<T> {
    if (typeof key !== "string" || !key.trim()) {
      throw new TypeError("Contribution key must be a non-empty string");
    }
    if (key !== key.trim()) {
      throw new TypeError("Contribution key cannot start or end with whitespace");
    }
    this.#rememberContract(token);
    return this.#extensionStore(token).contribute(`${ownerId}/${key}`, value);
  }

  #extensionStore<T>(token: Extension<T>): ExtensionStore<T> & ExtensionView<T> {
    let store = this.#extensionStores.get(token.id);
    if (!store) {
      store = new ExtensionStore();
      this.#extensionStores.set(token.id, store);
    }
    return store as ExtensionStore<T>;
  }

  #rememberContract(token: { readonly id: string; readonly kind: ContractKind }) {
    this.#validateContract(this.#contractKinds, token);
  }

  #commitContractKinds(kinds: ReadonlyMap<string, ContractKind>) {
    for (const [id, kind] of kinds) this.#contractKinds.set(id, kind);
  }

  #validateContract(
    kinds: Map<string, ContractKind>,
    token: { readonly id: string; readonly kind: ContractKind },
  ) {
    const previous = kinds.get(token.id);
    if (previous && previous !== token.kind) {
      throw new DougongError(
        "CONTRACT_CONFLICT",
        `Contract '${token.id}' is used as both '${previous}' and '${token.kind}'`,
      );
    }
    kinds.set(token.id, token.kind);
  }
}

export function createApp(options?: CreateAppOptions): Application {
  return new ApplicationImpl(options);
}
