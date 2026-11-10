import type { ContractRegistryWriter } from "../contracts/contract-registry.js";
import { DougongError, providesInvalidCode, serviceUnavailableCode } from "../contracts/errors.js";
import type { Logger } from "../contracts/logging.js";
import type { EventHub } from "../events/event-hub.js";
import type { ContributionRegistry } from "../contributions/contribution-registry.js";
import { Lifetime, type ReleaseFailure } from "../lifetime/lifetime.js";
import type { InstallationRecord, InstallationDeclaration } from "../composition/installation.js";
import type { InstanceContext } from "../composition/plugin.js";
import { normalizePlainRecord } from "../internal/record.js";
import type { Awaitable, ResourceAuthority } from "../contracts/resource.js";
import { ScopedLogger } from "./scoped-logger.js";

export interface InstanceEnvironment {
  readonly resourceAuthority: ResourceAuthority;
  readonly hostName: string;
  readonly logger: Logger<unknown>;
  readonly report: (error: unknown) => void;
  readonly releaseFailed: (failure: ReleaseFailure) => void;
  readonly changed: () => void;
  readonly events: EventHub;
  readonly contributions: ContributionRegistry;
  readonly contracts: ContractRegistryWriter;
  readonly startupSignal: AbortSignal;
  readonly shutdownTimeoutMilliseconds: number | undefined;
}

export class Instance {
  readonly installation: InstallationRecord;
  readonly declaration: InstallationDeclaration;
  readonly generation: number;
  readonly lifetime: Lifetime;
  readonly settled: Promise<void>;
  readonly #environment: InstanceEnvironment;
  readonly #services = new Map<string, unknown>();

  constructor(
    installation: InstallationRecord,
    declaration: InstallationDeclaration,
    generation: number,
    environment: InstanceEnvironment,
  ) {
    this.installation = installation;
    this.declaration = declaration;
    this.generation = generation;
    this.#environment = environment;
    this.lifetime = new Lifetime({
      resourceAuthority: environment.resourceAuthority,
      label: `${installation.id}@${generation}`,
      report: environment.report,
      releaseFailed: environment.releaseFailed,
      changed: environment.changed,
      startupSignal: environment.startupSignal,
      ...(environment.shutdownTimeoutMilliseconds === undefined
        ? {}
        : { shutdownTimeoutMilliseconds: environment.shutdownTimeoutMilliseconds }),
    });
    this.settled = Object.freeze(this.lifetime.settled.then(() => this.#services.clear()));
    void this.settled.catch(() => undefined);
  }

  async prepare(dependencies: Readonly<Record<string, unknown>>, configuration: unknown) {
    const signal = this.lifetime.signal;
    const environment = this.#environment;
    const metadata = Object.freeze({
      hostName: environment.hostName,
      installationId: this.installation.id,
      pluginName: this.declaration.plugin.name,
      generation: this.generation,
      groupId: this.installation.groupId,
    });
    const remember = environment.contracts.remember.bind(environment.contracts);
    const context: InstanceContext = Object.freeze({
      dependencies,
      lifetime: this.lifetime.handle,
      events: environment.events.scope(this.lifetime, remember),
      contributions: environment.contributions.scope(this.lifetime, this.installation.id, remember),
      metadata,
      logger: this.lifetime.use(new ScopedLogger(environment.logger, metadata)).handle,
    });
    const { setup } = this.declaration.plugin;
    const { value: output } = await this.lifetime.run(() => setup(context, configuration));
    AbortSignal.prototype.throwIfAborted.call(signal);
    this.#provide(output, signal);
  }

  // Setup output is plugin data: capture the declared aliases once, then publish them together.
  #provide(output: unknown, signal: AbortSignal) {
    const entries = Object.entries(this.declaration.plugin.provides);
    const invalidOutput = (message: string, options?: ErrorOptions) =>
      new DougongError(providesInvalidCode, message, {
        ...options,
        details: { installation: this.installation.id },
      });
    if (!entries.length) {
      if (output !== undefined)
        throw invalidOutput("Plugin without provisions must return undefined");
      return;
    }
    let values: Readonly<Record<string, unknown>>;
    try {
      values = normalizePlainRecord(output, "Provided Services", {
        fields: new Set(entries.map(([alias]) => alias)),
      });
    } catch (cause) {
      throw invalidOutput("Plugin returned invalid or unreadable provided Services", { cause });
    }
    AbortSignal.prototype.throwIfAborted.call(signal);
    for (const [alias] of entries) {
      if (!Object.hasOwn(values, alias)) throw invalidOutput("Plugin did not provide " + alias);
    }
    for (const [alias, token] of entries) this.#services.set(token.id, values[alias]);
  }

  read(serviceId: string): unknown {
    if (!this.#services.has(serviceId))
      throw new DougongError(serviceUnavailableCode, "Service has not been prepared: " + serviceId);
    return this.#services.get(serviceId);
  }

  use<T, Result>(serviceId: string, callback: (value: T) => Awaitable<Result>) {
    return this.lifetime.borrow(() => callback(this.read(serviceId) as T));
  }

  publish() {
    this.lifetime.detachStartupSignal();
    this.lifetime.publish();
  }
}
