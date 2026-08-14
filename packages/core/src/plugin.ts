import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Extension, OptionalService, Requirement, Service } from "./contracts";
import type { ExtensionRequirementView } from "./extension-store";
import type { LifetimeOperations, Logger, PluginMeta } from "./lifetime";
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
      : T extends Extension<unknown>
        ? ExtensionRequirementView<T>
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
    readonly meta: PluginMeta;
    readonly log: Logger;
  };

export interface PluginDefinition<
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

function isContract(value: unknown, kind: "service" | "extension") {
  if (!value || typeof value !== "object") return false;
  const token = value as { readonly id?: unknown; readonly kind?: unknown };
  return (
    token.kind === kind &&
    typeof token.id === "string" &&
    token.id.length > 0 &&
    token.id === token.id.trim()
  );
}

export function definePlugin<
  Config = void,
  Requires extends Requirements = {},
  Provides extends Provisions = {},
  ConfigInput = Config,
>(
  definition: PluginDefinition<Config, Requires, Provides, ConfigInput>,
): PluginDefinition<Config, Requires, Provides, ConfigInput> {
  if (typeof definition?.name !== "string" || !definition.name.trim()) {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (definition.name !== definition.name.trim()) {
    throw new TypeError("Plugin name cannot start or end with whitespace");
  }
  if (typeof definition.setup !== "function") {
    throw new TypeError(`Plugin '${definition.name}' must define setup()`);
  }
  if (
    definition.config !== undefined &&
    typeof definition.config["~standard"]?.validate !== "function"
  ) {
    throw new TypeError(`Plugin '${definition.name}' config must implement Standard Schema`);
  }

  for (const [key, requirement] of Object.entries(definition.requires ?? {})) {
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
        throw new TypeError(`Optional requirement '${key}' must wrap a service contract`);
      }
    } else if (!isContract(requirement, "service") && !isContract(requirement, "extension")) {
      throw new TypeError(`Plugin requirement '${key}' must be a service or extension contract`);
    }
  }

  for (const [key, provision] of Object.entries(definition.provides ?? {})) {
    if (!key.trim()) throw new TypeError("Plugin provision alias cannot be empty");
    if (key !== key.trim()) {
      throw new TypeError("Plugin provision alias cannot start or end with whitespace");
    }
    if (!isContract(provision, "service")) {
      throw new TypeError(`Plugin provision '${key}' must be a service contract`);
    }
  }

  const requires = definition.requires ? Object.freeze({ ...definition.requires }) : undefined;
  const provides = definition.provides ? Object.freeze({ ...definition.provides }) : undefined;

  return Object.freeze({
    ...definition,
    ...(requires ? { requires } : {}),
    ...(provides ? { provides } : {}),
  });
}
