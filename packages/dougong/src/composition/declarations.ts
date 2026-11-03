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
} & (undefined extends ConfigurationInputOf<Declaration>
  ? { readonly configuration?: NoInfer<ConfigurationInputOf<Declaration>> }
  : { readonly configuration: NoInfer<ConfigurationInputOf<Declaration>> });

export type InstallationArguments<Declaration extends AnyPlugin = AnyPlugin> =
  Declaration extends unknown
    ? [plugin: Declaration, options: InstallationOptions<Declaration>]
    : never;

// Configuration-only updates must be valid for every possible installed declaration.
type SharedConfigurationInput<Declaration extends AnyPlugin> = (
  Declaration extends unknown ? (input: ConfigurationInputOf<Declaration>) => void : never
) extends (input: infer Input) => void
  ? Input
  : never;

// Omitting configuration retains captured input; it does not request a schema default.
type InstallationReplacement<
  Declaration extends AnyPlugin,
  PreviousInput,
> = Declaration extends unknown
  ? {
      readonly plugin: Declaration;
      readonly origin?: InstallationOrigin;
    } & ([PreviousInput] extends [ConfigurationInputOf<Declaration>]
      ? { readonly configuration?: ConfigurationInputOf<Declaration> }
      : { readonly configuration: ConfigurationInputOf<Declaration> })
  : never;

export type InstallationUpdate<Declaration extends AnyPlugin = AnyPlugin> =
  | InstallationReplacement<Declaration, ConfigurationInputOf<Declaration>>
  | {
      readonly plugin?: never;
      readonly configuration: SharedConfigurationInput<Declaration>;
      readonly origin?: never;
    };

export interface ChangeSet {
  // Inferring the complete tuple preserves correlations that separate parameters would lose.
  install<Arguments extends readonly [plugin: AnyPlugin, options: unknown]>(
    ...declaration: Arguments & NoInfer<InstallationArguments<Arguments[0]>>
  ): Installation<Arguments[0]>;
  update<Declaration extends AnyPlugin>(
    installation: Installation<Declaration>,
    update: NoInfer<InstallationUpdate<Declaration>>,
  ): void;
  remove<Declaration extends AnyPlugin>(installation: Installation<Declaration>): void;
  group(id: string, parent?: Group): Group;
  removeGroup(group: Group): void;
}

type InitialInstallationFromArguments<Arguments> = Arguments extends [
  plugin: infer Declaration,
  options: infer Options,
]
  ? Omit<Options, "group"> & {
      readonly plugin: Declaration;
      readonly groupId?: string;
    }
  : never;

export type InitialInstallation<Declaration extends AnyPlugin = AnyPlugin> =
  InitialInstallationFromArguments<InstallationArguments<Declaration>>;
