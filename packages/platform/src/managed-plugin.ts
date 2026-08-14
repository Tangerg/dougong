import type { PluginHandle, Provisions, Requirements } from "@dougong/core";
import type {
  ManagedPlugin,
  NormalizedArtifact,
  PlatformChangeSet,
  PluginArtifact,
} from "./platform-api";
import type { ManagedPluginStatus } from "./diagnostics";
import { PlatformError } from "./errors";

export interface ManagedPluginOwner<Reference> {
  change(): PlatformChangeSet<Reference>;
  activateRecord(
    record: ManagedPluginRecord<Reference>,
    stack: ReadonlyArray<ManagedPluginRecord<Reference>>,
    signal: AbortSignal,
  ): Promise<void>;
}

class ManagedPluginHandleImpl<Reference> implements ManagedPlugin<Reference> {
  readonly #record: ManagedPluginRecord<Reference>;

  constructor(record: ManagedPluginRecord<Reference>) {
    this.#record = record;
    Object.freeze(this);
  }

  get name() {
    return this.#record.name;
  }

  get manifest() {
    return this.#record.manifest;
  }

  get status() {
    return this.#record.status;
  }

  ready() {
    return this.#record.ready();
  }

  activate() {
    return this.#record.activate();
  }

  update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>) {
    return this.#record.update(artifact);
  }

  remove() {
    return this.#record.remove();
  }
}

/** Internal stable identity and activation state machine behind an opaque handle. */
export class ManagedPluginRecord<Reference> {
  #owner: ManagedPluginOwner<Reference> | undefined;
  #artifact: NormalizedArtifact<Reference> | undefined;
  #manifest: NormalizedArtifact<Reference>["manifest"];
  #status: ManagedPluginStatus = "pending";
  #error: unknown;
  #coreHandle: PluginHandle | undefined;
  #queue: Promise<void> = Promise.resolve();
  #operationController: AbortController | undefined;
  readonly #waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  readonly handle: ManagedPlugin<Reference>;

  constructor(artifact: NormalizedArtifact<Reference>) {
    this.#artifact = artifact;
    this.#manifest = artifact.manifest;
    this.handle = new ManagedPluginHandleImpl(this);
  }

  attach(owner: ManagedPluginOwner<Reference>) {
    if (this.#owner) throw new TypeError(`Plugin '${this.name}' is already attached`);
    this.#owner = owner;
  }

  get name() {
    return this.#manifest.name;
  }

  get manifest() {
    return this.#manifest;
  }

  get artifact() {
    return this.#artifact!;
  }

  get status() {
    return this.#status;
  }

  get error() {
    return this.#error;
  }

  get coreHandle() {
    return this.#coreHandle;
  }

  ready() {
    if (this.#status === "active") return this.#coreHandle!.ready();
    if (this.#status === "failed" || this.#status === "removed") {
      return Promise.reject(
        this.#error ??
          new PlatformError("PLUGIN_UNAVAILABLE", `Plugin '${this.name}' is unavailable`),
      );
    }
    return new Promise<void>((resolve, reject) => this.#waiters.add({ resolve, reject }));
  }

  activate() {
    const owner = this.#owner;
    if (!owner) return Promise.reject(this.#unavailable());
    return this.#enqueue((signal) => owner.activateRecord(this, [], signal));
  }

  async update<
    Config = void,
    Requires extends Requirements = {},
    Provides extends Provisions = {},
    ConfigInput = Config,
  >(artifact: PluginArtifact<Reference, Config, Requires, Provides, ConfigInput>): Promise<void> {
    const owner = this.#owner;
    if (!owner) throw this.#unavailable();
    await owner.change().update(this.handle, artifact).commit();
  }

  async remove(): Promise<void> {
    const owner = this.#owner;
    if (!owner) {
      if (this.#status === "removed" || this.#status === "failed") return;
      throw this.#unavailable();
    }
    await owner.change().remove(this.handle).commit();
  }

  runDependency(stack: ReadonlyArray<ManagedPluginRecord<Reference>>) {
    const owner = this.#owner;
    if (!owner) return Promise.reject(this.#unavailable());
    return this.#enqueue((signal) => owner.activateRecord(this, stack, signal));
  }

  loading() {
    this.#error = undefined;
    this.#status = "loading";
  }

  activated(handle: PluginHandle) {
    this.#coreHandle = handle;
    this.#error = undefined;
    this.#status = "active";
    for (const waiter of this.#waiters) {
      void handle.ready().then(waiter.resolve, waiter.reject);
    }
    this.#waiters.clear();
  }

  replaced(
    artifact: NormalizedArtifact<Reference>,
    handle: PluginHandle | undefined,
    active = false,
  ) {
    this.#artifact = artifact;
    this.#manifest = artifact.manifest;
    this.#coreHandle = handle;
    this.#error = undefined;
    this.#status = active ? "active" : "registered";
  }

  failed(error: unknown) {
    this.#error = error;
    this.#status = "failed";
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  abandon(error: unknown) {
    this.failed(error);
    this.#artifact = undefined;
    this.#owner = undefined;
  }

  removed() {
    const error = new PlatformError("PLUGIN_REMOVED", `Plugin '${this.name}' has been removed`);
    this.#coreHandle = undefined;
    this.#artifact = undefined;
    this.#owner = undefined;
    this.#error = error;
    this.#status = "removed";
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  cancel() {
    this.#operationController?.abort();
  }

  settled() {
    return this.#queue;
  }

  #enqueue(operation: (signal: AbortSignal) => Promise<void>) {
    const run = async () => {
      const controller = new AbortController();
      this.#operationController = controller;
      try {
        await operation(controller.signal);
      } finally {
        if (this.#operationController === controller) this.#operationController = undefined;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #unavailable() {
    return (
      this.#error ??
      new PlatformError(
        "PLUGIN_UNAVAILABLE",
        `Plugin '${this.name}' registration has not been committed`,
      )
    );
  }
}
