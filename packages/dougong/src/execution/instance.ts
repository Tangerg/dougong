import type { ContractRegistryWriter } from "../contracts/contract-registry.js";
import { DougongError } from "../contracts/errors.js";
import { ScopedLogger, type Logger } from "../contracts/logging.js";
import type { EventHub } from "../events/event-hub.js";
import type { ContributionRegistry } from "../contributions/contribution-store.js";
import { Lifetime } from "../lifetime/lifetime.js";
import type { InstallationRecord, InstallationDeclaration } from "../composition/installation.js";
import type { InstanceContext } from "../composition/plugin.js";
import { normalizePlainRecord } from "../internal/record.js";
import type { Awaitable } from "../contracts/resource.js";

export interface InstanceEnvironment {
  readonly hostName: string;
  readonly logger: Logger;
  readonly report: (error: unknown) => void;
  readonly changed: () => void;
  readonly events: EventHub;
  readonly contributions: ContributionRegistry;
  readonly contracts: ContractRegistryWriter;
  readonly startupSignal: AbortSignal;
  readonly shutdownTimeoutMs: number | undefined;
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
      changed: environment.changed,
      parentSignal: environment.startupSignal,
      ...(environment.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: environment.shutdownTimeoutMs }),
    });
  }

  async prepare(deps: Readonly<Record<string, unknown>>, config: unknown) {
    const environment = this.environment;
    const meta = Object.freeze({
      hostName: environment.hostName,
      installationId: this.installation.id,
      pluginName: this.declaration.plugin.name,
      generation: this.generation,
      groupId: this.installation.groupId,
    });
    const context: InstanceContext = Object.freeze({
      deps,
      lifetime: this.lifetime.handle,
      events: environment.events.scope(this.lifetime, (token) =>
        environment.contracts.remember(token),
      ),
      contributions: environment.contributions.scope(this.lifetime, this.installation.id, (token) =>
        environment.contracts.remember(token),
      ),
      meta,
      log: this.lifetime.handle.use(new ScopedLogger(environment.logger, meta)),
    });
    const output = await this.lifetime.prepare(() =>
      this.declaration.plugin.setup(context, config),
    );
    this.lifetime.signal.throwIfAborted();
    const entries = Object.entries(this.declaration.plugin.provides);
    if (!entries.length) {
      if (output !== undefined)
        throw new DougongError(
          "PROVIDES_INVALID",
          "Plugin without provisions must return undefined",
        );
      return;
    }
    const values = normalizePlainRecord(output, "Provided Services", {
      fields: new Set(entries.map(([alias]) => alias)),
    });
    this.lifetime.signal.throwIfAborted();
    for (const [alias, token] of entries) {
      if (!Object.hasOwn(values, alias))
        throw new DougongError("PROVIDES_INVALID", "Plugin did not provide " + alias);
      this.#services.set(token.id, values[alias]);
    }
  }

  read(serviceId: string): unknown {
    if (!this.#services.has(serviceId))
      throw new DougongError("SERVICE_UNAVAILABLE", "Service has not been prepared: " + serviceId);
    return this.#services.get(serviceId);
  }

  use<T, R>(serviceId: string, callback: (value: T) => Awaitable<R>) {
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
