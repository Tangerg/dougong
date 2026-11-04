import type { ContractRegistryWriter } from "../contracts/contract-registry.js";
import { DougongError, providesInvalidCode, serviceUnavailableCode } from "../contracts/errors.js";
import { ScopedLogger, type Logger } from "../contracts/logging.js";
import type { EventHub } from "../events/event-hub.js";
import type { ContributionRegistry } from "../contributions/contribution-store.js";
import { Lifetime, type ReleaseFailure } from "../lifetime/lifetime.js";
import type { InstallationRecord, InstallationDeclaration } from "../composition/installation.js";
import type { InstanceContext } from "../composition/plugin.js";
import { normalizePlainRecord } from "../internal/record.js";
import type { Awaitable } from "../contracts/resource.js";

export interface InstanceEnvironment {
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
  readonly lifetime: Lifetime;
  readonly #services = new Map<string, unknown>();

  constructor(
    readonly installation: InstallationRecord,
    readonly declaration: InstallationDeclaration,
    readonly generation: number,
    private readonly environment: InstanceEnvironment,
  ) {
    this.lifetime = new Lifetime({
      label: installation.id + "@" + generation,
      report: environment.report,
      releaseFailed: environment.releaseFailed,
      changed: environment.changed,
      parentSignal: environment.startupSignal,
      ...(environment.shutdownTimeoutMilliseconds === undefined
        ? {}
        : { shutdownTimeoutMilliseconds: environment.shutdownTimeoutMilliseconds }),
    });
  }

  async prepare(dependencies: Readonly<Record<string, unknown>>, configuration: unknown) {
    const signal = this.lifetime.signal;
    const environment = this.environment;
    const metadata = Object.freeze({
      hostName: environment.hostName,
      installationId: this.installation.id,
      pluginName: this.declaration.plugin.name,
      generation: this.generation,
      groupId: this.installation.groupId,
    });
    const context: InstanceContext = Object.freeze({
      dependencies,
      lifetime: this.lifetime.handle,
      events: environment.events.scope(this.lifetime, (token) =>
        environment.contracts.remember(token),
      ),
      contributions: environment.contributions.scope(this.lifetime, this.installation.id, (token) =>
        environment.contracts.remember(token),
      ),
      metadata,
      logger: this.lifetime.use(new ScopedLogger(environment.logger, metadata)).handle,
    });
    const { setup } = this.declaration.plugin;
    const { value: output } = await this.lifetime.prepare(() => setup(context, configuration));
    AbortSignal.prototype.throwIfAborted.call(signal);
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
    for (const [alias, token] of entries) {
      if (!Object.hasOwn(values, alias)) throw invalidOutput("Plugin did not provide " + alias);
      this.#services.set(token.id, values[alias]);
    }
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

  async dispose() {
    try {
      await this.lifetime.dispose();
    } finally {
      if (this.lifetime.phase === "disposed") this.#services.clear();
    }
  }
}
