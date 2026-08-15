import type { ChangeSet, Installation, InstallationUpdate } from "./host-api";
import type { AnyPlugin } from "./installation";
import type { InstallationRecord } from "./installation";
import { definePlugin, type Plugin, type Provisions, type Requirements } from "./plugin";

type DeclarationUpdate =
  | { readonly kind: "plugin"; readonly plugin: AnyPlugin }
  | { readonly kind: "config"; readonly config: unknown }
  | {
      readonly kind: "plugin-and-config";
      readonly plugin: AnyPlugin;
      readonly config: unknown;
    };

export type ChangeOperation =
  | { readonly kind: "install"; readonly installation: InstallationRecord }
  | {
      readonly kind: "update";
      readonly installation: InstallationRecord;
      readonly declaration: DeclarationUpdate;
    }
  | { readonly kind: "remove"; readonly installation: InstallationRecord };

interface ChangePort {
  create(
    plugin: AnyPlugin,
    config: unknown,
  ): {
    readonly installation: InstallationRecord;
    readonly handle: object;
  };
  resolve(handle: object): InstallationRecord;
  execute(operations: ReadonlyArray<ChangeOperation>): Promise<void>;
  attach(installation: InstallationRecord): void;
  discard(installation: InstallationRecord, error: unknown): void;
}

type ChangeSetState =
  | { readonly phase: "open"; readonly host: ChangePort }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> }
  | { readonly phase: "discarded" };

const draftDiscarders = new WeakMap<ChangeSetDraft, (error: unknown) => void>();

export function discardPluginChangeSetDraft(draft: ChangeSetDraft, error: unknown) {
  draftDiscarders.get(draft)?.(error);
}

/**
 * Rich one-shot draft for the canonical mutation path. It owns target
 * uniqueness, handle authority, sealing and commit idempotency before the
 * application ever sees a candidate graph.
 */
export class ChangeSetDraft implements ChangeSet {
  readonly #operations = new Map<InstallationRecord, ChangeOperation>();
  #state: ChangeSetState;

  constructor(host: ChangePort) {
    this.#state = { phase: "open", host };
    draftDiscarders.set(this, (error) => this.#discard(error));
    Object.freeze(this);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput> {
    const host = this.#requireOpen();
    const definition = definePlugin(plugin) as unknown as AnyPlugin;
    const draft = host.create(definition, config[0]);
    this.#stage({ kind: "install", installation: draft.installation });
    return draft.handle as Installation<Config, Requires, Provides, ConfigInput>;
  }

  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: Installation<Config, Requires, Provides, ConfigInput>,
    update: InstallationUpdate<Config, Requires, Provides, ConfigInput>,
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
    let declaration: DeclarationUpdate;
    if (plugin && hasConfig) {
      declaration = { kind: "plugin-and-config", plugin, config: update.config };
    } else if (plugin) {
      declaration = { kind: "plugin", plugin };
    } else {
      declaration = { kind: "config", config: update.config };
    }
    const operation: ChangeOperation = { kind: "update", installation, declaration };
    this.#stage(operation);
    return this;
  }

  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    handle: Installation<Config, Requires, Provides, ConfigInput>,
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
      throw new TypeError("Core ChangeSet commit is already being prepared");
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

  #stage(operation: ChangeOperation) {
    if (this.#operations.has(operation.installation)) {
      throw new TypeError(
        `Installation '${operation.installation.id}' can only appear once in the same ChangeSet`,
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
