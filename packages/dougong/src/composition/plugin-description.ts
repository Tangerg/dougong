import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { normalizePlainRecord } from "../internal/record.js";
import { assertSynchronous } from "../internal/synchronous-result.js";
import { captureConfiguration, type ConfigurationValue } from "./configuration.js";
import { normalizePlugin, type AnyPlugin } from "./plugin.js";

export interface PluginDescriptionOptions {
  readonly jsonSchemaTarget?: StandardJSONSchemaV1.Target;
}

export type PluginConfigurationDescriptor =
  | { readonly status: "none" }
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
  readonly requires: ReadonlyArray<{
    readonly alias: string;
    readonly id: string;
    readonly kind: "service" | "extensionPoint";
    readonly optional: boolean;
  }>;
  readonly provides: ReadonlyArray<{ readonly alias: string; readonly id: string }>;
  readonly configuration: PluginConfigurationDescriptor;
}

const descriptionOptionFields = new Set(["jsonSchemaTarget"]);

export function describePlugin(
  plugin: AnyPlugin,
  options: PluginDescriptionOptions = {},
): PluginDescriptor {
  const input = normalizePlainRecord(options, "Plugin description options", {
    fields: descriptionOptionFields,
  });
  const target = input.jsonSchemaTarget === undefined ? "draft-2020-12" : input.jsonSchemaTarget;
  if (typeof target !== "string" || !target || target.trim() !== target) {
    throw new TypeError("JSON Schema target must be a non-empty trimmed string");
  }
  const declaration = normalizePlugin(plugin);
  const schema = declaration.configuration?.["~standard"];
  let configuration: PluginConfigurationDescriptor;
  if (!schema) configuration = Object.freeze({ status: "none" });
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
        const token = requirement.kind === "optional" ? requirement.service : requirement;
        return Object.freeze({
          alias,
          id: token.id,
          kind: token.kind,
          optional: requirement.kind === "optional",
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
