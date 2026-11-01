import type { AnyPlugin, Plugin } from "./plugin.js";
import type { ConfigurationValue } from "./configuration.js";
import type { InstallationState } from "../contracts/status.js";
export type InstallationOrigin = Readonly<Record<string, ConfigurationValue>>;

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

type ConfigurationInputOf<Declaration extends AnyPlugin> =
  Declaration extends Plugin<infer _Configuration, infer _Requires, infer _Provides, infer Input>
    ? Input
    : unknown;

export type InstallationOptions<Declaration extends AnyPlugin = AnyPlugin> = {
  readonly id: string;
  readonly group?: Group;
  readonly origin?: InstallationOrigin;
} & ([ConfigurationInputOf<Declaration>] extends [void]
  ? { readonly configuration?: ConfigurationInputOf<Declaration> }
  : { readonly configuration: ConfigurationInputOf<Declaration> });

export type InstallationUpdate<Declaration extends AnyPlugin = AnyPlugin> =
  | {
      readonly plugin: Declaration;
      readonly configuration?: ConfigurationInputOf<Declaration>;
      readonly origin?: InstallationOrigin;
    }
  | {
      readonly plugin?: never;
      readonly configuration: ConfigurationInputOf<Declaration>;
      readonly origin?: never;
    };

export interface ChangeSet {
  install<Declaration extends AnyPlugin>(
    plugin: Declaration,
    options: InstallationOptions<Declaration>,
  ): Installation<Declaration>;
  update<Declaration extends AnyPlugin>(
    installation: Installation<Declaration>,
    update: InstallationUpdate<Declaration>,
  ): void;
  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>): void;
  group(id: string, parent?: Group): Group;
  removeGroup(group: Group): void;
}

export interface InitialInstallation {
  readonly id: string;
  readonly plugin: AnyPlugin;
  readonly configuration?: unknown;
  readonly origin?: InstallationOrigin;
  readonly groupId?: string;
}
