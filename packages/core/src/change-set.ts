import type { PluginChangeSet, PluginHandle, PluginUpdate } from "./application-api";
import type { AnyPlugin } from "./plugin-instance";
import type { PluginInstance } from "./plugin-instance";
import { definePlugin, type PluginDefinition, type Provisions, type Requirements } from "./plugin";

export type ChangeOperation =
  | { readonly kind: "install"; readonly record: PluginInstance }
  | {
      readonly kind: "update";
      readonly record: PluginInstance;
      readonly plugin?: AnyPlugin;
      readonly hasConfig: boolean;
      readonly config: unknown;
    }
  | { readonly kind: "remove"; readonly record: PluginInstance };

const cancellations = new WeakMap<PluginChangeSetDraft, (error: unknown) => void>();

export function cancelPluginChangeSet(draft: PluginChangeSetDraft, error: unknown) {
  cancellations.get(draft)?.(error);
}

/**
 * Rich one-shot draft for the canonical mutation path. It owns target
 * uniqueness, handle authority, sealing and commit idempotency before the
 * application ever sees a candidate graph.
 */
export class PluginChangeSetDraft implements PluginChangeSet {
  readonly #operations = new Map<PluginInstance, ChangeOperation>();
  #create:
    | ((
        plugin: AnyPlugin,
        config: unknown,
      ) => {
        readonly record: PluginInstance;
        readonly handle: object;
      })
    | undefined;
  #resolve: ((handle: object) => PluginInstance) | undefined;
  #execute: ((operations: ReadonlyArray<ChangeOperation>) => Promise<void>) | undefined;
  #attach: ((record: PluginInstance) => void) | undefined;
  #discard: ((record: PluginInstance, error: unknown) => void) | undefined;
  #state: "open" | "committed" | "cancelled" = "open";
  #commitPromise: Promise<void> | undefined;

  constructor(options: {
    create: (
      plugin: AnyPlugin,
      config: unknown,
    ) => {
      readonly record: PluginInstance;
      readonly handle: object;
    };
    resolve: (handle: object) => PluginInstance;
    execute: (operations: ReadonlyArray<ChangeOperation>) => Promise<void>;
    attach: (record: PluginInstance) => void;
    discard: (record: PluginInstance, error: unknown) => void;
  }) {
    this.#create = options.create;
    this.#resolve = options.resolve;
    this.#execute = options.execute;
    this.#attach = options.attach;
    this.#discard = options.discard;
    cancellations.set(this, (error) => this.#cancel(error));
    Object.freeze(this);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: PluginDefinition<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): PluginHandle<Config, Requires, Provides, ConfigInput> {
    this.#assertOpen();
    const definition = definePlugin(plugin) as unknown as AnyPlugin;
    const draft = this.#create!(definition, config[0]);
    this.#stage({ kind: "install", record: draft.record });
    return draft.handle as PluginHandle<Config, Requires, Provides, ConfigInput>;
  }

  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
    update: PluginUpdate<Config, Requires, Provides, ConfigInput>,
  ) {
    this.#assertOpen();
    if (!update || typeof update !== "object") {
      throw new TypeError("Plugin update must be an object");
    }
    const hasPlugin = Object.hasOwn(update, "plugin");
    const hasConfig = Object.hasOwn(update, "config");
    if (!hasPlugin && !hasConfig) {
      throw new TypeError("Plugin update must include 'plugin' or 'config'");
    }

    const record = this.#resolve!(handle);
    const plugin = hasPlugin ? (definePlugin(update.plugin!) as unknown as AnyPlugin) : undefined;
    const operation: ChangeOperation = plugin
      ? {
          kind: "update",
          record,
          plugin,
          hasConfig,
          config: update.config,
        }
      : {
          kind: "update",
          record,
          hasConfig,
          config: update.config,
        };
    this.#stage(operation);
    return this;
  }

  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: PluginHandle<Config, Requires, Provides, ConfigInput>,
  ) {
    this.#assertOpen();
    this.#stage({ kind: "remove", record: this.#resolve!(handle) });
    return this;
  }

  commit() {
    if (this.#commitPromise) return this.#commitPromise;
    if (this.#state === "cancelled") {
      throw new TypeError("Cannot commit a cancelled ChangeSet");
    }
    this.#state = "committed";
    const operations = Object.freeze([...this.#operations.values()]);
    const attach = this.#attach!;
    for (const operation of operations) {
      if (operation.kind === "install") attach(operation.record);
    }
    const execute = this.#execute!;
    this.#releaseAuthority();
    if (!operations.length) {
      this.#commitPromise = Promise.resolve();
      return this.#commitPromise;
    }
    try {
      this.#commitPromise = execute(operations);
    } catch (error) {
      this.#commitPromise = Promise.reject(error);
    }
    return this.#commitPromise;
  }

  #cancel(error: unknown) {
    if (this.#state !== "open") return;
    this.#state = "cancelled";
    const operations = [...this.#operations.values()];
    const discard = this.#discard!;
    this.#releaseAuthority();
    for (const operation of operations) {
      if (operation.kind === "install") discard(operation.record, error);
    }
    cancellations.delete(this);
  }

  #stage(operation: ChangeOperation) {
    if (this.#operations.has(operation.record)) {
      throw new TypeError(
        `Plugin '${operation.record.id}' can only appear once in the same ChangeSet`,
      );
    }
    this.#operations.set(operation.record, Object.freeze(operation));
  }

  #assertOpen() {
    if (this.#state !== "open") throw new TypeError("Cannot modify a committed ChangeSet");
  }

  #releaseAuthority() {
    this.#operations.clear();
    this.#create = undefined;
    this.#resolve = undefined;
    this.#execute = undefined;
    this.#attach = undefined;
    this.#discard = undefined;
    cancellations.delete(this);
  }
}
