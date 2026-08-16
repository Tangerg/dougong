import type { ChangeSet, Installation, InstallationUpdate } from "./host-api";
import type { InstallationRecord } from "./installation";
import { assertPlainRecord } from "./record";
import {
  normalizePlugin,
  type ErasedPlugin,
  type Plugin,
  type Provisions,
  type Requirements,
} from "./plugin";

type DeclarationUpdate =
  | { readonly kind: "plugin"; readonly plugin: ErasedPlugin }
  | { readonly kind: "config"; readonly config: unknown }
  | {
      readonly kind: "plugin-and-config";
      readonly plugin: ErasedPlugin;
      readonly config: unknown;
    };

const installationUpdateFields = new Set(["plugin", "config"]);

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
    plugin: ErasedPlugin,
    config: unknown,
  ): {
    readonly record: InstallationRecord;
    readonly publicInstallation: object;
  };
  resolve(installation: object): InstallationRecord;
  execute(operations: ReadonlyArray<ChangeOperation>): Promise<void>;
  attach(installation: InstallationRecord): void;
  discard(installation: InstallationRecord, error: unknown): void;
}

type ChangeSetState =
  | { readonly phase: "open"; readonly port: ChangePort }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> }
  | { readonly phase: "discarded" };

const draftDiscarders = new WeakMap<ChangeSetDraft, (error: unknown) => void>();

export function discardChangeSetDraft(draft: ChangeSetDraft, error: unknown) {
  draftDiscarders.get(draft)?.(error);
}

/**
 * Rich one-shot draft for the canonical mutation path. It owns target
 * uniqueness, Installation authority, sealing and commit idempotency before
 * the Host ever sees a candidate graph.
 */
export class ChangeSetDraft implements ChangeSet {
  readonly #operations = new Map<InstallationRecord, ChangeOperation>();
  #state: ChangeSetState;

  constructor(port: ChangePort) {
    this.#state = { phase: "open", port };
    draftDiscarders.set(this, (error) => this.#discard(error));
    Object.freeze(this);
  }

  install<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    plugin: Plugin<Config, Requires, Provides, ConfigInput>,
    ...config: [ConfigInput] extends [void] ? [config?: ConfigInput] : [config: ConfigInput]
  ): Installation<Config, Requires, Provides, ConfigInput> {
    const port = this.#requireOpen();
    const normalized = normalizePlugin(plugin);
    const draft = port.create(normalized, config[0]);
    this.#stage({ kind: "install", installation: draft.record });
    return draft.publicInstallation as Installation<Config, Requires, Provides, ConfigInput>;
  }

  update<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    installation: Installation<Config, Requires, Provides, ConfigInput>,
    update: InstallationUpdate<Config, Requires, Provides, ConfigInput>,
  ) {
    const port = this.#requireOpen();
    assertPlainRecord(update, "Installation update", { fields: installationUpdateFields });
    const hasPlugin = Object.hasOwn(update, "plugin");
    const hasConfig = Object.hasOwn(update, "config");
    if (!hasPlugin && !hasConfig) {
      throw new TypeError("Installation update must include 'plugin' or 'config'");
    }

    const record = port.resolve(installation);
    let plugin: ErasedPlugin | undefined;
    if (hasPlugin) {
      const replacement = update.plugin;
      if (!replacement) throw new TypeError("Installation update 'plugin' must be a Plugin");
      plugin = normalizePlugin(replacement);
    }
    let declaration: DeclarationUpdate;
    if (plugin && hasConfig) {
      declaration = { kind: "plugin-and-config", plugin, config: update.config };
    } else if (plugin) {
      declaration = { kind: "plugin", plugin };
    } else {
      declaration = { kind: "config", config: update.config };
    }
    const operation: ChangeOperation = { kind: "update", installation: record, declaration };
    this.#stage(operation);
    return this;
  }

  remove<Config, Requires extends Requirements, Provides extends Provisions, ConfigInput>(
    installation: Installation<Config, Requires, Provides, ConfigInput>,
  ) {
    const port = this.#requireOpen();
    this.#stage({ kind: "remove", installation: port.resolve(installation) });
    return this;
  }

  commit() {
    const state = this.#state;
    if (state.phase === "submitted") return state.promise;
    if (state.phase === "discarded") {
      throw new Error("Cannot commit a discarded ChangeSet");
    }
    if (state.phase === "committing") {
      throw new Error("Core ChangeSet commit is already being prepared");
    }
    this.#state = { phase: "committing" };
    const operations = Object.freeze([...this.#operations.values()]);
    const port = state.port;
    try {
      for (const operation of operations) {
        if (operation.kind === "install") port.attach(operation.installation);
      }
    } catch (error) {
      for (const operation of operations) {
        if (operation.kind === "install") port.discard(operation.installation, error);
      }
      return this.#submit(Promise.reject(error));
    }
    let promise: Promise<void>;
    try {
      promise = port.execute(operations);
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
      if (operation.kind === "install") state.port.discard(operation.installation, error);
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
    return state.port;
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
