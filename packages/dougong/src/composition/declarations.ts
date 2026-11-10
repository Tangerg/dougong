import type { AnyPlugin, PluginAuthoringConstraint, PluginConfigurationInput } from "./plugin.js";
import type { ConfigurationValue } from "./configuration.js";

export type InstallationOrigin = Readonly<Record<string, ConfigurationValue>>;
export type InstallationState =
  "pending" | "stopped" | "running" | "changing" | "removed" | "quarantined";

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

export type InstallationOptions<Declaration extends AnyPlugin = AnyPlugin> = {
  readonly id: string;
  readonly group?: Group;
  readonly origin?: InstallationOrigin;
} & (undefined extends PluginConfigurationInput<Declaration>
  ? { readonly configuration?: NoInfer<PluginConfigurationInput<Declaration>> }
  : { readonly configuration: NoInfer<PluginConfigurationInput<Declaration>> });

export type InstallationArguments<Declaration extends AnyPlugin = AnyPlugin> =
  Declaration extends unknown
    ? [
        plugin: Declaration & PluginAuthoringConstraint<Declaration>,
        options: InstallationOptions<Declaration>,
      ]
    : never;

// Configuration-only updates must be valid for every possible installed declaration.
type SharedConfigurationInput<Declaration extends AnyPlugin> = (
  Declaration extends unknown ? (input: PluginConfigurationInput<Declaration>) => void : never
) extends (input: infer Input) => void
  ? Input
  : never;

// Omitting configuration retains captured input; it does not request a schema default.
type InstallationReplacement<
  Declaration extends AnyPlugin,
  PreviousInput,
> = Declaration extends unknown
  ? {
      readonly plugin: Declaration & PluginAuthoringConstraint<Declaration>;
      readonly origin?: InstallationOrigin;
    } & ([PreviousInput] extends [PluginConfigurationInput<Declaration>]
      ? { readonly configuration?: PluginConfigurationInput<Declaration> }
      : { readonly configuration: PluginConfigurationInput<Declaration> })
  : never;

export type InstallationUpdate<Declaration extends AnyPlugin = AnyPlugin> =
  | InstallationReplacement<Declaration, PluginConfigurationInput<Declaration>>
  | {
      readonly plugin?: never;
      readonly configuration: SharedConfigurationInput<Declaration>;
      readonly origin?: never;
    };

export type InstallationUpdateAuthoring<Update> = Update extends {
  readonly plugin: infer Declaration extends AnyPlugin;
}
  ? { readonly plugin: PluginAuthoringConstraint<Declaration> }
  : { readonly plugin?: never };

export interface ChangeSet {
  // Inferring the complete tuple preserves correlations that separate parameters would lose.
  install<Arguments extends readonly [plugin: AnyPlugin, options: unknown]>(
    ...declaration: Arguments & NoInfer<InstallationArguments<Arguments[0]>>
  ): Installation<Arguments[0]>;
  update<Declaration extends AnyPlugin, const Update extends object>(
    installation: Installation<Declaration>,
    update: Update &
      NoInfer<InstallationUpdate<Declaration>> &
      NoInfer<InstallationUpdateAuthoring<Update>>,
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
