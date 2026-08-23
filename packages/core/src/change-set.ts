import type {
  ChangeSet,
  Installation,
  InstallationUpdate,
  PluginConfigArguments,
} from "./host-api";
import type { InstallationRecord } from "./installation";
import { assertPlainRecord } from "./record";
import { normalizePlugin, type AnyPlugin, type NormalizedPlugin } from "./plugin";

type DeclarationUpdate =
  | { readonly kind: "plugin"; readonly plugin: NormalizedPlugin }
  | { readonly kind: "config"; readonly config: unknown }
  | {
      readonly kind: "plugin-and-config";
      readonly plugin: NormalizedPlugin;
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
  readonly create: (
    plugin: NormalizedPlugin,
    config: unknown,
  ) => {
    readonly record: InstallationRecord;
    readonly facade: Installation<AnyPlugin>;
  };
  readonly resolve: (installation: object) => InstallationRecord;
  readonly execute: (operations: ReadonlyArray<ChangeOperation>) => Promise<void>;
  readonly attach: (installation: InstallationRecord) => void;
  readonly discard: (installation: InstallationRecord, error: unknown) => void;
}

type DraftInstallationFactory = ChangePort["create"];

type ChangeSetState =
  | { readonly phase: "open"; readonly port: ChangePort }
  | { readonly phase: "committing" }
  | { readonly phase: "submitted"; readonly promise: Promise<void> }
  | { readonly phase: "discarded" };

interface ChangeSetDraftControl {
  readonly discard: (error: unknown) => void;
  readonly install: <Declaration extends AnyPlugin>(
    plugin: Declaration,
    config: unknown,
    create?: DraftInstallationFactory,
  ) => Installation<Declaration>;
}

const draftControls = new WeakMap<ChangeSetDraft, ChangeSetDraftControl>();

export function discardChangeSetDraft(draft: ChangeSetDraft, error: unknown) {
  draftControls.get(draft)?.discard(error);
}

/** Stages explicit ownership into a shared draft without widening the public ChangeSet API. */
export function stageChangeSetInstallation<Declaration extends AnyPlugin>(
  draft: ChangeSetDraft,
  plugin: Declaration,
  config: unknown,
  create: DraftInstallationFactory,
) {
  const control = draftControls.get(draft);
  if (!control) throw new Error("ChangeSet draft control has been released");
  return control.install(plugin, config, create);
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
    draftControls.set(this, {
      discard: (error) => this.#discard(error),
      install: (plugin, config, create) => this.#install(plugin, config, create),
    });
    Object.freeze(this);
  }

  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration> {
    return this.#install(plugin, config[0]);
  }

  #install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    config: unknown,
    create?: DraftInstallationFactory,
  ): Installation<Declaration> {
    const port = this.#requireOpen();
    const normalized = normalizePlugin(plugin);
    const draft = (create ?? port.create)(normalized, config);
    this.#stage({ kind: "install", installation: draft.record });
    // Runtime authority is the facade identity; Declaration exists only in the
    // invariant compile-time brand and is recovered at this single erasure seam.
    return draft.facade as unknown as Installation<Declaration>;
  }

  update<Declaration extends AnyPlugin>(
    installation: Installation<Declaration>,
    update: InstallationUpdate<Declaration>,
  ) {
    const port = this.#requireOpen();
    assertPlainRecord(update, "Installation update", { fields: installationUpdateFields });
    const hasPlugin = Object.hasOwn(update, "plugin");
    const hasConfig = Object.hasOwn(update, "config");
    if (!hasPlugin && !hasConfig) {
      throw new TypeError("Installation update must include 'plugin' or 'config'");
    }

    const record = port.resolve(installation);
    let plugin: NormalizedPlugin | undefined;
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
  }

  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>) {
    const port = this.#requireOpen();
    this.#stage({ kind: "remove", installation: port.resolve(installation) });
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
    draftControls.delete(this);
  }
}
