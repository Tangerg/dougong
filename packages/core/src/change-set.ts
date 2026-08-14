import type { PluginChangeSet, PluginHandle, PluginUpdate } from "./application-api";
import type { AnyPlugin } from "./plugin-installation";
import type { PluginInstallation } from "./plugin-installation";
import { definePlugin, type PluginDefinition, type Provisions, type Requirements } from "./plugin";

export type PluginChangeOperation =
  | { readonly kind: "install"; readonly installation: PluginInstallation }
  | {
      readonly kind: "update";
      readonly installation: PluginInstallation;
      readonly plugin?: AnyPlugin;
      readonly hasConfig: boolean;
      readonly config: unknown;
    }
  | { readonly kind: "remove"; readonly installation: PluginInstallation };

interface PluginChangeHost {
  create(
    plugin: AnyPlugin,
    config: unknown,
  ): {
    readonly installation: PluginInstallation;
    readonly handle: object;
  };
  resolve(handle: object): PluginInstallation;
  execute(operations: ReadonlyArray<PluginChangeOperation>): Promise<void>;
  attach(installation: PluginInstallation): void;
  discard(installation: PluginInstallation, error: unknown): void;
}

type PluginChangeSetState =
  | { readonly phase: "open"; readonly host: PluginChangeHost }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> }
  | { readonly phase: "discarded" };

const draftDiscarders = new WeakMap<PluginChangeSetDraft, (error: unknown) => void>();

export function discardPluginChangeSetDraft(draft: PluginChangeSetDraft, error: unknown) {
  draftDiscarders.get(draft)?.(error);
}

/**
 * Rich one-shot draft for the canonical mutation path. It owns target
 * uniqueness, handle authority, sealing and commit idempotency before the
 * application ever sees a candidate graph.
 */
export class PluginChangeSetDraft implements PluginChangeSet {
  readonly #operations = new Map<PluginInstallation, PluginChangeOperation>();
  #state: PluginChangeSetState;

  constructor(host: PluginChangeHost) {
    this.#state = { phase: "open", host };
    draftDiscarders.set(this, (error) => this.#discard(error));
    Object.freeze(this);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput> {
    const host = this.#requireOpen();
    const definition = definePlugin(plugin) as unknown as AnyPlugin;
    const draft = host.create(definition, config[0]);
    this.#stage({ kind: "install", installation: draft.installation });
    return draft.handle as PluginHandle<Config, Requires, Provides, ConfigInput>;
  }

  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
    update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
  ) {
    const host = this.#requireOpen();
    if (!update || typeof update !== "object") {
      throw new TypeError("Plugin update must be an object");
    }
    const hasPlugin = Object.hasOwn(update, "plugin");
    const hasConfig = Object.hasOwn(update, "config");
    if (!hasPlugin && !hasConfig) {
      throw new TypeError("Plugin update must include 'plugin' or 'config'");
    }

    const installation = host.resolve(handle);
    let plugin: AnyPlugin | undefined;
    if (hasPlugin) {
      const replacement = update.plugin;
      if (!replacement) throw new TypeError("Plugin update 'plugin' must be a plugin definition");
      plugin = definePlugin(replacement) as unknown as AnyPlugin;
    }
    const operation: PluginChangeOperation = plugin
      ? {
          kind: "update",
          installation,
          plugin,
          hasConfig,
          config: update.config,
        }
      : {
          kind: "update",
          installation,
          hasConfig,
          config: update.config,
        };
    this.#stage(operation);
    return this;
  }

  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
  ) {
    const host = this.#requireOpen();
    this.#stage({ kind: "remove", installation: host.resolve(handle) });
    return this;
  }

  commit() {
    const state = this.#state;
    if (state.phase === "submitted") return state.promise;
    if (state.phase === "discarded") {
      throw new TypeError("Cannot commit a discarded ChangeSet");
    }
    if (state.phase === "committing") {
      throw new TypeError("ChangeSet commit is already being prepared");
    }
    this.#state = { phase: "committing" };
    const operations = Object.freeze([...this.#operations.values()]);
    const host = state.host;
    try {
      for (const operation of operations) {
        if (operation.kind === "install") host.attach(operation.installation);
      }
    } catch (error) {
      for (const operation of operations) {
        if (operation.kind === "install") host.discard(operation.installation, error);
      }
      return this.#submit(Promise.reject(error));
    }
    if (!operations.length) {
      return this.#submit(Promise.resolve());
    }
    let promise: Promise<void>;
    try {
      promise = host.execute(operations);
    } catch (error) {
      promise = Promise.reject(error);
    }
    return this.#submit(promise);
  }

  #discard(error: unknown) {
    const state = this.#state;
    if (state.phase !== "open") return;
    this.#state = { phase: "discarded" };
    const operations = [...this.#operations.values()];
    this.#releaseOperations();
    for (const operation of operations) {
      if (operation.kind === "install") state.host.discard(operation.installation, error);
    }
  }

  #stage(operation: PluginChangeOperation) {
    if (this.#operations.has(operation.installation)) {
      throw new TypeError(
        `Plugin '${operation.installation.id}' can only appear once in the same ChangeSet`,
      );
    }
    this.#operations.set(operation.installation, Object.freeze(operation));
  }

  #requireOpen() {
    const state = this.#state;
    if (state.phase !== "open") {
      throw new TypeError(`Cannot modify a ${state.phase} ChangeSet`);
    }
    return state.host;
  }

  #submit(promise: Promise<void>) {
    this.#state = { phase: "submitted", promise };
    this.#releaseOperations();
    return promise;
  }

  #releaseOperations() {
    this.#operations.clear();
    draftDiscarders.delete(this);
  }
}
