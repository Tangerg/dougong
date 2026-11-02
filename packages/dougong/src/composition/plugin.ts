import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  normalizeContract,
  normalizeRequirement,
  type ContractIdentity,
  type ContractKind,
  type ExtensionPoint,
  type OptionalService,
  type Requirement,
  type Service,
} from "../contracts/contracts.js";
import type {
  ContributionView,
  ContributionOperations,
} from "../contributions/contribution-store.js";
import type { LifetimeContext } from "../lifetime/lifetime.js";
import type { Logger } from "../contracts/logging.js";
import type { EventOperations } from "../events/event-hub.js";
import type { Awaitable } from "../contracts/resource.js";
import { normalizePlainRecord } from "../internal/record.js";

export type { Awaitable } from "../contracts/resource.js";

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

interface PluginSchema<Input, Output> extends StandardSchemaV1<Input, Output> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output> & {
    readonly jsonSchema?: StandardJSONSchemaV1.Converter;
  };
}

export interface InstanceMetadata {
  readonly hostName: string;
  readonly installationId: string;
  readonly pluginName: string;
  readonly generation: number;
  readonly groupId: string | undefined;
}

export interface PluginContext<T extends Requirements = Requirements> {
  readonly dependencies: ResolvedRequirements<T>;
  readonly lifetime: LifetimeContext;
  readonly events: EventOperations;
  readonly contributions: ContributionOperations;
  readonly metadata: InstanceMetadata;
  readonly logger: Logger;
}

export interface Plugin<
  Configuration = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigurationInput = Configuration,
> {
  readonly name: string;
  readonly configuration?: PluginSchema<ConfigurationInput, Configuration>;
  readonly requires?: Requires;
  readonly provides?: Provides;
  readonly setup: (
    context: PluginContext<Requires>,
    configuration: Configuration,
  ) => Awaitable<SetupOutput<NoInfer<Provides>>>;
}

// The uncallable setup signature preserves variance across heterogeneous declarations.
export interface AnyPlugin {
  readonly name: string;
  readonly configuration?: unknown;
  readonly requires?: Requirements;
  readonly provides?: Provisions;
  readonly setup: (context: never, configuration: never) => unknown;
}

export type InstanceContext = Omit<PluginContext<{}>, "dependencies"> & {
  readonly dependencies: Readonly<Record<string, unknown>>;
};

export interface NormalizedPlugin {
  readonly name: string;
  readonly configuration?: PluginSchema<unknown, unknown>;
  readonly requires: Requirements;
  readonly provides: Provisions;
  readonly setup: (
    context: InstanceContext,
    configuration: unknown,
  ) => Awaitable<void | Readonly<Record<string, unknown>>>;
}

const pluginFields = new Set(["name", "configuration", "requires", "provides", "setup"]);

interface PluginContractDeclaration {
  readonly alias: string;
  readonly kind: ContractKind;
  readonly role: "requirement" | "provision";
}

// NoInfer prevents a caller annotation from widening the inferred setup contract.
export function definePlugin<
  Configuration = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigurationInput = Configuration,
>(
  plugin: Plugin<Configuration, Requires, Provides, ConfigurationInput>,
): Plugin<
  NoInfer<Configuration>,
  NoInfer<Requires>,
  NoInfer<Provides>,
  NoInfer<ConfigurationInput>
> {
  return normalizePluginDeclaration(plugin) as Plugin<
    Configuration,
    Requires,
    Provides,
    ConfigurationInput
  >;
}

// Freezing alone does not prove a declaration was validated by this copy of Core.
const capturedDeclarations = new WeakSet<AnyPlugin>();

function normalizePluginDeclaration(plugin: AnyPlugin): AnyPlugin {
  if (capturedDeclarations.has(plugin)) return plugin;
  const declaration = normalizePlainRecord(plugin, "Plugin declaration", { fields: pluginFields });
  const { name, configuration, setup } = declaration;
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new TypeError("Plugin name cannot start or end with whitespace");
  }
  if (typeof setup !== "function") {
    throw new TypeError(`Plugin '${name}' must define setup()`);
  }
  const capturedSchema =
    configuration === undefined ? undefined : captureSchema(configuration, name);
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

  const captured = Object.freeze({
    name,
    ...(capturedSchema === undefined ? {} : { configuration: capturedSchema }),
    requires,
    provides,
    setup,
  });
  capturedDeclarations.add(captured);
  return captured;
}

// Composed declarations can reuse our frozen protocol without chaining another validator or exporter.
const capturedSchemas = new WeakSet<object>();

function captureSchema(value: unknown, name: string): PluginSchema<unknown, unknown> {
  const invalid = () =>
    new TypeError("Plugin '" + name + "' configuration must implement Standard Schema V1");
  if (!value || (typeof value !== "object" && typeof value !== "function")) throw invalid();
  if (capturedSchemas.has(value)) return value as PluginSchema<unknown, unknown>;
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") throw invalid();
  const { version, vendor, validate, jsonSchema } = standard as {
    readonly version?: unknown;
    readonly vendor?: unknown;
    readonly validate?: unknown;
    readonly jsonSchema?: unknown;
  };
  if (version !== 1 || typeof vendor !== "string" || typeof validate !== "function")
    throw invalid();
  const captured: StandardSchemaV1["~standard"]["validate"] = (...validationArguments) =>
    Reflect.apply(validate, standard, validationArguments);
  const converter = jsonSchema === undefined ? undefined : captureSchemaConverter(jsonSchema, name);
  const schema = Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor,
      validate: captured,
      ...(converter === undefined ? {} : { jsonSchema: converter }),
    }),
  });
  capturedSchemas.add(schema);
  return schema;
}

function captureSchemaConverter(value: unknown, name: string): StandardJSONSchemaV1.Converter {
  const invalid = () =>
    new TypeError(
      "Plugin '" + name + "' jsonSchema must implement Standard JSON Schema input/output exporters",
    );
  if (!value || (typeof value !== "object" && typeof value !== "function")) throw invalid();
  const { input, output } = value as { readonly input?: unknown; readonly output?: unknown };
  if (typeof input !== "function" || typeof output !== "function") throw invalid();
  return Object.freeze({
    input: (options: StandardJSONSchemaV1.Options) => Reflect.apply(input, value, [options]),
    output: (options: StandardJSONSchemaV1.Options) => Reflect.apply(output, value, [options]),
  });
}

class PluginContracts {
  readonly #declarations = new Map<string, PluginContractDeclaration>();

  constructor(private readonly pluginName: string) {}

  normalizeRequirements(declarations: Requirements): Requirements {
    const requires: Record<string, Requirement> = Object.create(null);
    for (const [alias, value] of Object.entries(declarations)) {
      this.#assertAlias(alias, "requirement");
      const requirement = normalizeRequirement(
        value,
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
