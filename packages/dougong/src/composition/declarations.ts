import type { AnyPlugin, Plugin } from "./plugin.js";
import type { ConfigValue } from "./configuration.js";
import type { InstallationState } from "../contracts/status.js";
export type InstallationOrigin = Readonly<Record<string, ConfigValue>>;

declare const installationBrand: unique symbol;
declare const groupBrand: unique symbol;

export interface Installation<Declaration extends AnyPlugin = AnyPlugin> {
  readonly [installationBrand]: (declaration: Declaration) => Declaration;
  readonly id: string;
  readonly groupId: string | undefined;
  readonly status: InstallationState;
  readonly origin: InstallationOrigin | undefined;
}

export interface Group {
  readonly [groupBrand]: true;
  readonly id: string;
  readonly parentId: string | undefined;
}

type InputOf<P extends AnyPlugin> =
  P extends Plugin<infer _C, infer _R, infer _P, infer I> ? I : unknown;

export type InstallationOptions<P extends AnyPlugin = AnyPlugin> = {
  readonly id: string;
  readonly group?: Group;
  readonly origin?: InstallationOrigin;
} & ([InputOf<P>] extends [void]
  ? { readonly config?: InputOf<P> }
  : { readonly config: InputOf<P> });

export type InstallationUpdate<P extends AnyPlugin = AnyPlugin> =
  | { readonly plugin: P; readonly config?: InputOf<P>; readonly origin?: InstallationOrigin }
  | { readonly plugin?: never; readonly config: InputOf<P>; readonly origin?: never };

export interface ChangeSet {
  install<P extends AnyPlugin>(plugin: P, options: InstallationOptions<P>): Installation<P>;
  update<P extends AnyPlugin>(installation: Installation<P>, update: InstallationUpdate<P>): void;
  remove<P extends AnyPlugin>(installation: Installation<P>): void;
  group(id: string, parent?: Group): Group;
  removeGroup(group: Group): void;
}

export interface InitialInstallation {
  readonly id: string;
  readonly plugin: AnyPlugin;
  readonly config?: unknown;
  readonly origin?: InstallationOrigin;
  readonly groupId?: string;
}
