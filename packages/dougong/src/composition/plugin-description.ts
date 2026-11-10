import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { normalizePlainRecord, recordFields } from "../internal/record.js";
import { assertSynchronous } from "../internal/async-result.js";
import { assertTrimmedText } from "../internal/text.js";
import { captureConfiguration, type ConfigurationValue } from "./configuration.js";
import { normalizePlugin, type AnyPlugin } from "./plugin.js";
import { requiredContract } from "../contracts/contracts.js";

export interface PluginDescriptionOptions {
  readonly jsonSchemaTarget?: StandardJSONSchemaV1.Target;
}

export type PluginConfigurationDescriptor =
  | { readonly status: "schemaAbsent" }
  | { readonly status: "unavailable"; readonly vendor: string }
  | {
      readonly status: "available";
      readonly vendor: string;
      readonly target: StandardJSONSchemaV1.Target;
      readonly input: Readonly<Record<string, ConfigurationValue>>;
      readonly output: Readonly<Record<string, ConfigurationValue>>;
    };

export interface PluginDescriptor {
  readonly name: string;
  readonly requires: ReadonlyArray<
    { readonly alias: string; readonly id: string } & (
      | { readonly kind: "service"; readonly optional: boolean }
      | { readonly kind: "extensionPoint"; readonly optional: false }
    )
  >;
  readonly provides: ReadonlyArray<{ readonly alias: string; readonly id: string }>;
  readonly configuration: PluginConfigurationDescriptor;
}

const descriptionOptionFields = recordFields<PluginDescriptionOptions>()("jsonSchemaTarget");
const defaultJSONSchemaTarget: StandardJSONSchemaV1.Target = "draft-2020-12";

export function describePlugin(
  plugin: AnyPlugin,
  options: PluginDescriptionOptions = {},
): PluginDescriptor {
  const input = normalizePlainRecord(options, "Plugin description options", {
    fields: descriptionOptionFields,
  });
  const target =
    input.jsonSchemaTarget === undefined ? defaultJSONSchemaTarget : input.jsonSchemaTarget;
  assertTrimmedText(target, "JSON Schema target");
  const declaration = normalizePlugin(plugin);
  const schema = declaration.configuration?.["~standard"];
  let configuration: PluginConfigurationDescriptor;
  if (!schema) configuration = Object.freeze({ status: "schemaAbsent" });
  else if (!schema.jsonSchema)
    configuration = Object.freeze({ status: "unavailable", vendor: schema.vendor });
  else {
    const exportOptions = Object.freeze({ target });
    configuration = Object.freeze({
      status: "available",
      vendor: schema.vendor,
      target,
      input: captureJSONSchema(schema.jsonSchema.input(exportOptions)),
      output: captureJSONSchema(schema.jsonSchema.output(exportOptions)),
    });
  }
  return Object.freeze({
    name: declaration.name,
    requires: Object.freeze(
      Object.entries(declaration.requires).map(([alias, requirement]) => {
        const token = requiredContract(requirement);
        return Object.freeze({
          alias,
          id: token.id,
          ...(token.kind === "extensionPoint"
            ? { kind: token.kind, optional: false as const }
            : { kind: token.kind, optional: requirement.kind === "optional" }),
        });
      }),
    ),
    provides: Object.freeze(
      Object.entries(declaration.provides).map(([alias, token]) =>
        Object.freeze({ alias, id: token.id }),
      ),
    ),
    configuration,
  });
}

function captureJSONSchema(value: unknown): Readonly<Record<string, ConfigurationValue>> {
  assertSynchronous(value, "JSON Schema exporters must be synchronous");
  const schema = captureConfiguration(value);
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("JSON Schema exporters must return a plain data record");
  }
  return schema as Readonly<Record<string, ConfigurationValue>>;
}
