import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  normalizeContract,
  normalizeRequirement,
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
import { normalizePlainRecord } from "./record";

export type { Awaitable } from "./resource";

export type Requirements = Readonly<Record<string, Requirement>>;

export type Provisions = Readonly<
  Record<string, Extract<Requirement, { readonly kind: "service" }>>
>;

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

// The uncallable setup signature preserves variance across heterogeneous declarations.
export interface AnyPlugin {
  readonly name: string;
  readonly config?: unknown;
  readonly requires?: Requirements;
  readonly provides?: Provisions;
  readonly setup: (context: never, config: never) => unknown;
}

export type InstanceContext = LifetimeOperations &
  Readonly<Record<string, unknown>> & {
    readonly meta: InstanceMeta;
    readonly log: Logger;
  };

export interface NormalizedPlugin {
  readonly name: string;
  readonly config?: StandardSchemaV1<unknown, unknown>;
  readonly requires: Requirements;
  readonly provides: Provisions;
  readonly setup: (
    context: InstanceContext,
    config: unknown,
  ) => Awaitable<void | Readonly<Record<string, unknown>>>;
}

// Requirement aliases must not shadow Lifetime operations on the context.
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
const pluginFields = new Set(["name", "config", "requires", "provides", "setup"]);

interface PluginContractDeclaration {
  readonly alias: string;
  readonly kind: ContractKind;
  readonly role: "requirement" | "provision";
}

// NoInfer prevents a caller annotation from widening the inferred setup contract.
export function definePlugin<
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
>(
  plugin: Plugin<Config, Requires, Provides, ConfigInput>,
): Plugin<NoInfer<Config>, NoInfer<Requires>, NoInfer<Provides>, NoInfer<ConfigInput>> {
  return normalizePluginDeclaration(plugin) as Plugin<Config, Requires, Provides, ConfigInput>;
}

function normalizePluginDeclaration(plugin: AnyPlugin): AnyPlugin {
  const declaration = normalizePlainRecord(plugin, "Plugin declaration", { fields: pluginFields });
  const { name, config, setup } = declaration;
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new TypeError("Plugin name cannot start or end with whitespace");
  }
  if (typeof setup !== "function") {
    throw new TypeError(`Plugin '${name}' must define setup()`);
  }
  if (config !== undefined && !isStandardSchemaV1(config)) {
    throw new TypeError(`Plugin '${name}' config must implement Standard Schema V1`);
  }
  const declaredRequirements =
    declaration.requires === undefined
      ? undefined
      : normalizePlainRecord(declaration.requires, `Plugin '${name}' requires`);
  const declaredProvisions =
    declaration.provides === undefined
      ? undefined
      : normalizePlainRecord(declaration.provides, `Plugin '${name}' provides`);
  const contracts = new PluginContracts(name);
  const requires = contracts.normalizeRequirements(declaredRequirements ?? {});
  const provides = contracts.normalizeProvisions(declaredProvisions ?? {});

  return Object.freeze({
    name,
    ...(config === undefined ? {} : { config }),
    requires,
    provides,
    setup,
  });
}

function isStandardSchemaV1(value: unknown): value is StandardSchemaV1 {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") return false;
  const candidate = standard as {
    readonly version?: unknown;
    readonly vendor?: unknown;
    readonly validate?: unknown;
  };
  return (
    candidate.version === 1 &&
    typeof candidate.vendor === "string" &&
    typeof candidate.validate === "function"
  );
}

class PluginContracts {
  readonly #declarations = new Map<string, PluginContractDeclaration>();

  constructor(private readonly pluginName: string) {}

  normalizeRequirements(declarations: Requirements): Requirements {
    const requires: Record<string, Requirement> = Object.create(null);
    for (const [alias, value] of Object.entries(declarations)) {
      this.#assertAlias(alias, "requirement");
      if (reservedContextKeys.has(alias)) {
        throw new TypeError(`Plugin requirement '${alias}' conflicts with the context API`);
      }
      if (!value || typeof value !== "object") {
        throw new TypeError(`Plugin requirement '${alias}' is not a contract`);
      }
      const requirement = normalizeRequirement(
        normalizePlainRecord(value, `Plugin requirement '${alias}'`),
        `Plugin requirement '${alias}' must be a Service or ExtensionPoint`,
        `Optional requirement '${alias}' must wrap a Service`,
      );
      this.#remember(
        "requirement",
        alias,
        requirement.kind === "optional" ? requirement.service : requirement,
      );
      requires[alias] = requirement;
    }
    return Object.freeze(requires);
  }

  normalizeProvisions(declarations: Provisions): Provisions {
    const provides: Record<string, Provisions[string]> = Object.create(null);
    for (const [alias, value] of Object.entries(declarations)) {
      this.#assertAlias(alias, "provision");
      if (alias === "then") {
        throw new TypeError("Plugin provision alias 'then' conflicts with the Promise protocol");
      }
      const provision = normalizeContract(
        value,
        "service",
        `Plugin provision '${alias}' must be a Service`,
      );
      this.#remember("provision", alias, provision);
      provides[alias] = provision;
    }
    return Object.freeze(provides);
  }

  #assertAlias(alias: string, role: PluginContractDeclaration["role"]) {
    if (!alias.trim()) throw new TypeError(`Plugin ${role} alias cannot be empty`);
    if (alias !== alias.trim()) {
      throw new TypeError(`Plugin ${role} alias cannot start or end with whitespace`);
    }
  }

  #remember(role: PluginContractDeclaration["role"], alias: string, contract: ContractIdentity) {
    const previous = this.#declarations.get(contract.id);
    if (!previous) {
      this.#declarations.set(contract.id, { alias, kind: contract.kind, role });
      return;
    }
    if (previous.kind !== contract.kind) {
      throw new TypeError(
        `Plugin '${this.pluginName}' uses Contract '${contract.id}' as both ${contractLabel(previous.kind)} and ${contractLabel(contract.kind)}`,
      );
    }
    const label = contractLabel(contract.kind);
    if (previous.role !== role) {
      throw new TypeError(
        `Plugin '${this.pluginName}' cannot both require and provide ${label} '${contract.id}'`,
      );
    }
    throw new TypeError(
      `Plugin '${this.pluginName}' ${role} aliases '${previous.alias}' and '${alias}' reference the same ${label} '${contract.id}'`,
    );
  }
}

function contractLabel(kind: ContractKind) {
  if (kind === "extensionPoint") return "ExtensionPoint";
  if (kind === "event") return "Event";
  return "Service";
}

export function normalizePlugin(plugin: AnyPlugin): NormalizedPlugin {
  // Authoring generics are erased only after the declaration has passed validation.
  return normalizePluginDeclaration(plugin) as unknown as NormalizedPlugin;
}
