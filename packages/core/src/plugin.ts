import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  isContract,
  type ContractIdentity,
  type ContractKind,
  type ExtensionPoint,
  type OptionalService,
  type Requirement,
  type Service,
} from "./contracts";
import type { ContributionView } from "./contribution-store";
import type { InstanceMeta, LifetimeOperations, Logger } from "./lifetime";
import type { Awaitable } from "./resource";

export type { Awaitable } from "./resource";

export type Requirements = Readonly<Record<string, Requirement>>;
export type Provisions = Readonly<Record<string, Service<unknown>>>;

type ServiceValue<T> = T extends Service<infer Value> ? Value : never;

export type ResolvedRequirement<T> =
  T extends OptionalService<infer Value>
    ? Value | undefined
    : T extends Service<infer Value>
      ? Value
      : T extends ExtensionPoint<infer Value>
        ? ContributionView<Value>
        : never;

export type ResolvedRequirements<T extends Requirements> = {
  readonly [Key in keyof T]: ResolvedRequirement<T[Key]>;
};

export type ProvidedServices<T extends Provisions> = {
  readonly [Key in keyof T]: ServiceValue<T[Key]>;
};

type SetupOutput<T extends Provisions> = keyof T extends never ? void : ProvidedServices<T>;

export type PluginContext<T extends Requirements = Requirements> = LifetimeOperations &
  ResolvedRequirements<T> & {
    readonly meta: InstanceMeta;
    readonly log: Logger;
  };

export interface Plugin<
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
> {
  readonly name: string;
  readonly config?: StandardSchemaV1<ConfigInput, Config>;
  readonly requires?: Requires;
  readonly provides?: Provides;
  readonly setup: (
    context: PluginContext<Requires>,
    config: Config,
  ) => Awaitable<SetupOutput<NoInfer<Provides>>>;
}

/** Execution representation after public generic information has been checked and erased. */
export type ErasedPlugin = Plugin<unknown, Requirements, Provisions, unknown>;

const reservedContextKeys = new Set([
  "signal",
  "meta",
  "log",
  "cleanup",
  "lifetime",
  "spawn",
  "on",
  "emit",
  "contribute",
]);

interface PluginContractDeclaration {
  readonly alias: string;
  readonly kind: ContractKind;
  readonly role: "requirement" | "provision";
}

export function definePlugin<
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
>(
  plugin: Plugin<Config, Requires, Provides, ConfigInput>,
): Plugin<Config, Requires, Provides, ConfigInput> {
  if (typeof plugin?.name !== "string" || !plugin.name.trim()) {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (plugin.name !== plugin.name.trim()) {
    throw new TypeError("Plugin name cannot start or end with whitespace");
  }
  if (typeof plugin.setup !== "function") {
    throw new TypeError(`Plugin '${plugin.name}' must define setup()`);
  }
  if (plugin.config !== undefined && typeof plugin.config["~standard"]?.validate !== "function") {
    throw new TypeError(`Plugin '${plugin.name}' config must implement Standard Schema`);
  }

  const contracts = new Map<string, PluginContractDeclaration>();
  for (const [key, requirement] of Object.entries(plugin.requires ?? {})) {
    if (!key.trim()) throw new TypeError("Plugin requirement alias cannot be empty");
    if (key !== key.trim()) {
      throw new TypeError("Plugin requirement alias cannot start or end with whitespace");
    }
    if (reservedContextKeys.has(key)) {
      throw new TypeError(`Plugin requirement '${key}' conflicts with the context API`);
    }

    if (!requirement || typeof requirement !== "object") {
      throw new TypeError(`Plugin requirement '${key}' is not a contract`);
    }
    if (requirement.kind === "optional") {
      if (!isContract(requirement.service, "service")) {
        throw new TypeError(`Optional requirement '${key}' must wrap a Service`);
      }
    } else if (!isContract(requirement, "service") && !isContract(requirement, "extensionPoint")) {
      throw new TypeError(`Plugin requirement '${key}' must be a Service or ExtensionPoint`);
    }
    rememberPluginContract(
      plugin.name,
      contracts,
      "requirement",
      key,
      requirement.kind === "optional" ? requirement.service : requirement,
    );
  }

  for (const [key, provision] of Object.entries(plugin.provides ?? {})) {
    if (!key.trim()) throw new TypeError("Plugin provision alias cannot be empty");
    if (key !== key.trim()) {
      throw new TypeError("Plugin provision alias cannot start or end with whitespace");
    }
    if (!isContract(provision, "service")) {
      throw new TypeError(`Plugin provision '${key}' must be a Service`);
    }
    rememberPluginContract(plugin.name, contracts, "provision", key, provision);
  }

  const requires = plugin.requires ? Object.freeze({ ...plugin.requires }) : undefined;
  const provides = plugin.provides ? Object.freeze({ ...plugin.provides }) : undefined;

  return Object.freeze({
    ...plugin,
    ...(requires ? { requires } : {}),
    ...(provides ? { provides } : {}),
  });
}

function rememberPluginContract(
  pluginName: string,
  contracts: Map<string, PluginContractDeclaration>,
  role: PluginContractDeclaration["role"],
  alias: string,
  contract: ContractIdentity,
) {
  const previous = contracts.get(contract.id);
  if (!previous) {
    contracts.set(contract.id, { alias, kind: contract.kind, role });
    return;
  }
  if (previous.kind !== contract.kind) {
    throw new TypeError(
      `Plugin '${pluginName}' uses Contract '${contract.id}' as both ${contractLabel(previous.kind)} and ${contractLabel(contract.kind)}`,
    );
  }
  const label = contractLabel(contract.kind);
  if (previous.role !== role) {
    throw new TypeError(
      `Plugin '${pluginName}' cannot both require and provide ${label} '${contract.id}'`,
    );
  }
  throw new TypeError(
    `Plugin '${pluginName}' ${role} aliases '${previous.alias}' and '${alias}' reference the same ${label} '${contract.id}'`,
  );
}

function contractLabel(kind: ContractKind) {
  if (kind === "extensionPoint") return "ExtensionPoint";
  if (kind === "event") return "Event";
  return "Service";
}

/** The sole boundary that validates a public Plugin and erases authoring-only generics. */
export function normalizePlugin<
  Config,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigInput,
>(plugin: Plugin<Config, Requires, Provides, ConfigInput>): ErasedPlugin {
  // Config and alias types are authoring constraints. Core has already checked
  // the declaration here and deliberately stores the same value type-erased.
  return definePlugin(plugin) as unknown as ErasedPlugin;
}
