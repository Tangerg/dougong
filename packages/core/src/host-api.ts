import type { HostSnapshot, HostStatus, InstallationSnapshot } from "./diagnostics";
import type { Logger } from "./lifetime";
import type { LifecycleStatus } from "./lifecycle-status";
import type { AnyPlugin, Plugin } from "./plugin";
import type { ExtensionPoint, OptionalService, Service } from "./contracts";
import type { ContributionView } from "./contribution-store";
import type { SnapshotView } from "./snapshot-view";
import type { Awaitable } from "./resource";
import type { InstallationUpdate } from "./installation";
export type { InstallationUpdate } from "./installation";

declare const installationBrand: unique symbol;

/**
 * Makes the config argument required exactly when the Plugin declares one, so
 * `install(needsConfig)` fails to compile while `install(needsNothing)` stays a
 * one-argument call.
 */
export type PluginConfigArguments<Declaration extends AnyPlugin> =
  Declaration extends Plugin<infer _Config, infer _Requires, infer _Provides, infer ConfigInput>
    ? [ConfigInput] extends [void]
      ? [config?: ConfigInput]
      : [config: ConfigInput]
    : [config?: unknown];

/**
 * One installed Plugin, as a stable identity. The declaration behind it may be
 * replaced; this identity and its position in the ownership tree may not.
 *
 * Installation and Group state their own capabilities instead of sharing a
 * framework-wide lifecycle interface. Code that wants to treat them uniformly
 * declares the minimum it needs on the consuming side:
 *
 * ```ts
 * interface Removable {
 *   ready(): Promise<void>
 *   remove(): Promise<void>
 * }
 * ```
 */
export interface Installation<Declaration extends AnyPlugin = AnyPlugin> {
  readonly [installationBrand]: (declaration: Declaration) => Declaration;
  readonly id: string;
  readonly groupId: string;
  readonly status: LifecycleStatus;
  readonly diagnostics: SnapshotView<InstallationSnapshot>;
  ready(): Promise<void>;
  readonly update: (update: InstallationUpdate<Declaration>) => Promise<void>;
  remove(): Promise<void>;
}

/**
 * One transaction. Staged operations apply together or not at all, so a batch
 * that would leave a missing dependency between two of its own steps is valid —
 * only the committed end state has to resolve.
 *
 * `group()` is deliberately absent: a ChangeSet moves installations, and Group
 * structure is created through an `Installer`.
 */
export interface ChangeSet extends Pick<Installer, "install"> {
  update<Declaration extends AnyPlugin>(
    installation: Installation<Declaration>,
    update: InstallationUpdate<Declaration>,
  ): void;
  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>): void;
  commit(): Promise<void>;
}

export interface HostOptions {
  readonly name?: string;
  readonly logger?: Logger;
  /**
   * Terminal sink for failures with nowhere left to propagate — a background
   * task's rejection, a diagnostics subscriber that threw. It does not see
   * errors from `start()` or `commit()`; those are returned to their caller.
   */
  readonly onError?: (error: unknown) => Awaitable<void>;
}

/** Capability to install into an ownership position without controlling Host execution. */
export interface Installer {
  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    ...config: PluginConfigArguments<Declaration>
  ): Installation<Declaration>;
  group(name: string, configure: (group: Group) => void): Group;
  change(): ChangeSet;
}

/** Installation ownership only: never a capability scope or a permission boundary. */
export interface Group extends Installer {
  readonly id: string;
  readonly name: string;
  readonly status: LifecycleStatus;
  ready(): Promise<void>;
  remove(): Promise<void>;
}

/**
 * The execution boundary Dougong owns: commands, transactions, orchestration.
 *
 * `get()` and `contributions()` are for application code — the code that embeds
 * Dougong from outside the graph. A Plugin never reaches its dependencies this
 * way; it declares them in `requires` and receives them as context. That is the
 * difference between a declared dependency and a Service Locator, and it is why
 * `Host` is not reachable from `PluginContext`.
 */
export interface Host extends Installer {
  readonly name: string;
  readonly status: HostStatus;
  readonly diagnostics: SnapshotView<HostSnapshot>;
  get<T>(token: Service<T>): T;
  get<T>(token: OptionalService<T>): T | undefined;
  contributions<T>(token: ExtensionPoint<T>): ContributionView<T>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
