import type { Provisions, Requirements } from "@dougong/core";
import { PlatformError } from "./errors";
import type { ManagedPluginRecord } from "./managed-plugin";
import type {
  ManagedPlugin,
  NormalizedArtifact,
  PlatformChangeSet,
  PluginArtifact,
} from "./platform-api";

export type PlatformChange<Reference> =
  | {
      readonly kind: "register";
      readonly record: ManagedPluginRecord<Reference>;
      readonly artifact: NormalizedArtifact<Reference>;
    }
  | {
      readonly kind: "update";
      readonly record: ManagedPluginRecord<Reference>;
      readonly artifact: NormalizedArtifact<Reference>;
    }
  | { readonly kind: "remove"; readonly record: ManagedPluginRecord<Reference> };

export interface CandidatePlugin<Reference> {
  readonly record: ManagedPluginRecord<Reference>;
  readonly artifact: NormalizedArtifact<Reference>;
}

export interface PlatformChangeHost<Reference> {
  normalize<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ): NormalizedArtifact<Reference>;
  createRecord(artifact: NormalizedArtifact<Reference>): ManagedPluginRecord<Reference>;
  attachRecord(record: ManagedPluginRecord<Reference>): void;
  resolve(plugin: ManagedPlugin<Reference>): ManagedPluginRecord<Reference>;
  execute(operations: ReadonlyArray<PlatformChange<Reference>>): Promise<void>;
}

/** One-shot owner of platform candidate-graph and target-uniqueness rules. */
export class PlatformChangeSetDraft<Reference> implements PlatformChangeSet<Reference> {
  #host: PlatformChangeHost<Reference> | undefined;
  readonly #operations = new Map<ManagedPluginRecord<Reference>, PlatformChange<Reference>>();
  #open = true;
  #commitPromise: Promise<void> | undefined;

  constructor(host: PlatformChangeHost<Reference>) {
    this.#host = host;
    Object.freeze(this);
  }

  register<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>) {
    this.#assertOpen();
    const normalized = this.#host!.normalize(artifact);
    const record = this.#host!.createRecord(normalized);
    this.#stage({ kind: "register", record, artifact: normalized });
    return record.handle;
  }

  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(
    plugin: ManagedPlugin<Reference>,
    artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>,
  ) {
    this.#assertOpen();
    const record = this.#host!.resolve(plugin);
    const normalized = this.#host!.normalize(artifact);
    if (normalized.manifest.name !== record.name) {
      throw new PlatformError(
        "PLUGIN_IDENTITY",
        `Managed plugin '${record.name}' cannot change name to '${normalized.manifest.name}'`,
      );
    }
    this.#stage({ kind: "update", record, artifact: normalized });
    return this;
  }

  remove(plugin: ManagedPlugin<Reference>) {
    this.#assertOpen();
    this.#stage({ kind: "remove", record: this.#host!.resolve(plugin) });
    return this;
  }

  commit() {
    if (this.#commitPromise) return this.#commitPromise;
    this.#open = false;
    const host = this.#host!;
    const operations = Object.freeze([...this.#operations.values()]);
    try {
      for (const operation of operations) {
        if (operation.kind === "register") host.attachRecord(operation.record);
      }
    } catch (error) {
      for (const operation of operations) {
        if (operation.kind === "register") operation.record.abandon(error);
      }
      this.#host = undefined;
      this.#operations.clear();
      this.#commitPromise = Promise.reject(error);
      return this.#commitPromise;
    }
    this.#host = undefined;
    this.#operations.clear();
    if (!operations.length) {
      this.#commitPromise = Promise.resolve();
      return this.#commitPromise;
    }
    try {
      this.#commitPromise = host.execute(operations);
    } catch (error) {
      this.#commitPromise = Promise.reject(error);
    }
    return this.#commitPromise;
  }

  #stage(operation: PlatformChange<Reference>) {
    if (this.#operations.has(operation.record)) {
      throw new TypeError(
        `Plugin '${operation.record.name}' can only appear once in the same ChangeSet`,
      );
    }
    this.#operations.set(operation.record, Object.freeze(operation));
  }

  #assertOpen() {
    if (!this.#open) throw new TypeError("Cannot modify a committed ChangeSet");
  }
}
