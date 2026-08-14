import { DougongError } from "./errors";
import type { Lifetime } from "./lifetime";
import type { PluginDefinition, Provisions, Requirements } from "./plugin";
import type { GroupNode } from "./group";

export type PluginStatus = "pending" | "active" | "stopping" | "failed" | "removed";

export type AnyPlugin = PluginDefinition<unknown, Requirements, Provisions, unknown>;

export interface InstallationSpec {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
}

export interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly config: unknown;
  readonly lifetime: Lifetime;
}

export function installation(plugin: AnyPlugin, config: unknown): InstallationSpec {
  return Object.freeze({ plugin, config });
}

/**
 * A plugin installation is a stable identity whose declaration and runtime may
 * change. State transitions and ready waiters live here so orchestration code
 * cannot create a status that disagrees with the owned runtime.
 */
export class PluginInstance {
  #status: PluginStatus = "pending";
  #runtime: PluginRuntime | undefined;
  #error: unknown;
  #settled = false;
  #spec: InstallationSpec | undefined;
  #changed: (() => void) | undefined;

  readonly #waiters = new Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();

  constructor(
    readonly id: string,
    readonly index: number,
    readonly group: GroupNode,
    spec: InstallationSpec,
  ) {
    this.#spec = spec;
  }

  attach(changed: () => void) {
    if (this.#changed) throw new TypeError(`Plugin '${this.id}' is already attached`);
    this.#changed = changed;
  }

  get status() {
    return this.#status;
  }

  get runtime() {
    return this.#runtime;
  }

  get error() {
    return this.#error;
  }

  get spec() {
    return this.#spec!;
  }

  reconfigure(spec: InstallationSpec) {
    this.#spec = spec;
  }

  ready() {
    if (this.#settled) {
      if (this.#status === "active") return Promise.resolve();
      if (this.#status === "failed" || this.#status === "removed") {
        return Promise.reject(
          this.#error ??
            new DougongError("PLUGIN_UNAVAILABLE", `Plugin '${this.id}' is ${this.#status}`),
        );
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.#waiters.add({ resolve, reject });
    });
  }

  activate(runtime: PluginRuntime) {
    this.#runtime = runtime;
    this.#settled = false;
    this.#transition("active");
  }

  settle() {
    if (this.#settled) return;
    if (this.#status !== "active" && this.#status !== "failed" && this.#status !== "removed") {
      return;
    }
    this.#settled = true;
    if (this.#status === "active") {
      for (const waiter of this.#waiters) waiter.resolve();
    } else {
      const error =
        this.#error ??
        new DougongError("PLUGIN_UNAVAILABLE", `Plugin '${this.id}' is ${this.#status}`);
      for (const waiter of this.#waiters) waiter.reject(error);
    }
    this.#waiters.clear();
  }

  beginStopping() {
    if (!this.#runtime) return false;
    this.#transition("stopping");
    return true;
  }

  pending() {
    this.#runtime = undefined;
    this.#settled = false;
    this.#transition("pending");
  }

  fail(error: unknown) {
    this.#runtime = undefined;
    this.#settled = false;
    this.#error = error;
    this.#transition("failed", false);
  }

  abandon(error: unknown) {
    this.fail(error);
    this.settle();
    this.#spec = undefined;
    this.#changed = undefined;
  }

  remove() {
    const error = new DougongError("PLUGIN_REMOVED", `Plugin '${this.id}' has been removed`);
    this.#runtime = undefined;
    this.#settled = false;
    this.#error = error;
    this.#transition("removed", false);
    this.#spec = undefined;
    this.#changed = undefined;
  }

  #transition(status: PluginStatus, clearError = true) {
    this.#status = status;
    if (clearError) this.#error = undefined;
    this.#changed?.();
  }
}
