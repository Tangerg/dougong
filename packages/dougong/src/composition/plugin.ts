import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  contractKindName,
  normalizeContract,
  normalizeRequirement,
  requiredContract,
  type ContractIdentity,
  type ContractKind,
  type ExtensionPoint,
  type OptionalService,
  type Requirement,
  type Service,
  type ServiceIdentity,
} from "../contracts/contracts.js";
import type { ContributionView } from "../contributions/contribution-view.js";
import type { ContributionOperations } from "../contributions/contribution-registry.js";
import type { LifetimeContext } from "../lifetime/lifetime.js";
import type { Logger } from "../contracts/logging.js";
import type { EventOperations } from "../events/event-hub.js";
import type { Awaitable } from "../contracts/resource.js";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertTrimmedText } from "../internal/text.js";
import type { ReadonlyConfiguration } from "./configuration.js";

export type { Awaitable } from "../contracts/resource.js";

export type Requirements = Readonly<Record<string, Requirement>>;

export type Provisions = Readonly<Record<string, ServiceIdentity>>;

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

type EmptyContracts = Readonly<Record<PropertyKey, never>>;
type SetupOutput<T extends Provisions> = T extends EmptyContracts ? void : ProvidedServices<T>;

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

declare const pluginContractBrand: unique symbol;

type IsUnion<Value, Whole = Value> = Value extends unknown
  ? [Whole] extends [Value]
    ? false
    : true
  : never;

type HasOpenKey<Declaration> = true extends {
  [Key in keyof Declaration]-?: {} extends Record<Key, unknown> ? true : false;
}[keyof Declaration]
  ? true
  : false;

type ContractFields<Name extends string, Declaration> =
  true extends IsUnion<Declaration>
    ? never
    : Declaration extends EmptyContracts
      ? { readonly [Field in Name]?: EmptyContracts }
      : true extends HasOpenKey<Declaration>
        ? never
        : Exclude<keyof Declaration, string> extends never
          ? Declaration extends Required<Declaration>
            ? { readonly [Field in Name]: Declaration }
            : never
          : never;

type ProvisionValues<Declaration extends Provisions> = true extends {
  [Key in keyof Declaration]-?: IsUnion<Declaration[Key]>;
}[keyof Declaration]
  ? never
  : unknown;

// Without a schema, captured input is delivered directly; distinct type parameters cannot invent a transformation.
type ConfigurationDeclaration<Input, Output> = [Input] extends [Output]
  ? { readonly configuration?: PluginSchema<Input, Output> }
  : { readonly configuration: PluginSchema<Input, Output> };

type PluginAuthoring<
  Configuration,
  Requires extends Requirements,
  Provides extends Provisions,
  ConfigurationInput,
> = {
  readonly name: string;
  readonly configuration?: PluginSchema<ConfigurationInput, Configuration>;
  readonly requires?: Requires;
  readonly provides?: Provides;
  readonly setup: (
    context: PluginContext<NoInfer<Requires>>,
    configuration: ReadonlyConfiguration<Configuration>,
  ) => Awaitable<SetupOutput<NoInfer<Provides>>>;
} & ConfigurationDeclaration<ConfigurationInput, Configuration> &
  ContractFields<"requires", Requires> &
  ContractFields<"provides", Provides> &
  ProvisionValues<Provides>;

export type Plugin<
  Configuration = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigurationInput = Configuration,
> = PluginAuthoring<Configuration, Requires, Provides, ConfigurationInput> & {
  // Input stays invariant, and spreading a declaration cannot silently replace its checked setup contract.
  readonly [pluginContractBrand]?: {
    readonly input: (input: ConfigurationInput) => ConfigurationInput;
    readonly authoring: PluginAuthoring<Configuration, Requires, Provides, ConfigurationInput>;
  };
};

// The runtime boundary has no erased authoring guarantees; setup remains uncallable until Core resolves its environment.
export interface AnyPlugin {
  readonly name: string;
  readonly configuration?: unknown;
  readonly requires?: Requirements;
  readonly provides?: Provisions;
  readonly setup: (context: never, configuration: never) => unknown;
}

// Installation cannot erase an unchecked author's callback contract; dynamic ingress is explicitly AnyPlugin.
export type PluginAuthoringConstraint<Declaration extends AnyPlugin> = Declaration extends {
  readonly [pluginContractBrand]?: { readonly authoring: infer Authoring };
}
  ? Authoring extends Omit<Declaration, typeof pluginContractBrand>
    ? Authoring
    : never
  : AnyPlugin extends Declaration
    ? Parameters<Declaration["setup"]> extends [never, never]
      ? unknown
      : never
    : never;

export type PluginConfigurationInput<Declaration extends AnyPlugin> =
  Declaration extends PluginAuthoringConstraint<Declaration>
    ? Declaration extends {
        readonly [pluginContractBrand]?: { readonly input: (input: infer Input) => unknown };
      }
      ? Input
      : unknown
    : never;

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

const pluginFields = recordFields<AnyPlugin>()(
  "name",
  "configuration",
  "requires",
  "provides",
  "setup",
);

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
  plugin: PluginAuthoring<Configuration, Requires, Provides, ConfigurationInput>,
): NoInfer<Plugin<Configuration, Requires, Provides, ConfigurationInput>> {
  return capturePluginDeclaration(plugin) as Plugin<
    Configuration,
    Requires,
    Provides,
    ConfigurationInput
  >;
}

// Freezing alone does not prove a declaration was validated by this copy of Core.
const capturedDeclarations = new WeakMap<object, AnyPlugin>();

export function capturePluginDeclaration(plugin: unknown): AnyPlugin {
  const known =
    plugin !== null && typeof plugin === "object" ? capturedDeclarations.get(plugin) : undefined;
  if (known) return known;
  const declaration = normalizePlainRecord(plugin, "Plugin declaration", { fields: pluginFields });
  const { name, configuration, setup } = declaration;
  assertTrimmedText(name, "Plugin name");
  if (!isPluginSetup(setup)) {
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
  capturedDeclarations.set(captured, captured);
  return captured;
}

function isPluginSetup(value: unknown): value is AnyPlugin["setup"] {
  return typeof value === "function";
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
  readonly #pluginName: string;
  readonly #declarations = new Map<string, PluginContractDeclaration>();

  constructor(pluginName: string) {
    this.#pluginName = pluginName;
  }

  normalizeRequirements(declarations: Readonly<Record<string, unknown>>): Requirements {
    const requires: Record<string, Requirement> = Object.create(null);
    for (const [alias, value] of Object.entries(declarations)) {
      this.#assertAlias(alias, "requirement");
      const requirement = normalizeRequirement(
        value,
        `Plugin requirement '${alias}' must be a Service or ExtensionPoint`,
        `Optional requirement '${alias}' must wrap a Service`,
      );
      this.#remember("requirement", alias, requiredContract(requirement));
      requires[alias] = requirement;
    }
    return Object.freeze(requires);
  }

  normalizeProvisions(declarations: Readonly<Record<string, unknown>>): Provisions {
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
      ) as ServiceIdentity;
      this.#remember("provision", alias, provision);
      provides[alias] = provision;
    }
    return Object.freeze(provides);
  }

  #assertAlias(alias: string, role: PluginContractDeclaration["role"]) {
    assertTrimmedText(alias, `Plugin ${role} alias`);
  }

  #remember(role: PluginContractDeclaration["role"], alias: string, contract: ContractIdentity) {
    const previous = this.#declarations.get(contract.id);
    if (!previous) {
      this.#declarations.set(contract.id, { alias, kind: contract.kind, role });
      return;
    }
    if (previous.kind !== contract.kind) {
      throw new TypeError(
        `Plugin '${this.#pluginName}' uses Contract '${contract.id}' as both ${contractKindName(previous.kind)} and ${contractKindName(contract.kind)}`,
      );
    }
    const label = contractKindName(contract.kind);
    if (previous.role !== role) {
      throw new TypeError(
        `Plugin '${this.#pluginName}' cannot both require and provide ${label} '${contract.id}'`,
      );
    }
    throw new TypeError(
      `Plugin '${this.#pluginName}' ${role} aliases '${previous.alias}' and '${alias}' reference the same ${label} '${contract.id}'`,
    );
  }
}

export function normalizePlugin(plugin: unknown): NormalizedPlugin {
  // Authoring generics are erased only after the declaration has passed validation.
  return capturePluginDeclaration(plugin) as unknown as NormalizedPlugin;
}
