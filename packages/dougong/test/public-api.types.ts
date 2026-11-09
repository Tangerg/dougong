import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf } from "vitest";
import * as core from "dougong";
import {
  batchSnapshotNotifications,
  captureLogger,
  normalizePlainRecord,
  onAbort,
  recordFields,
  resolveValue,
  SerialQueue,
  SnapshotPublisher,
} from "dougong/advanced";

expectTypeOf<ConstructorParameters<typeof core.RecordedFailure>>().toEqualTypeOf<
  [error: unknown, fields?: ReadonlyArray<string>]
>();
expectTypeOf<typeof core.isError>().toEqualTypeOf<(value: unknown) => value is Error>();
expectTypeOf(resolveValue(Promise.resolve(1))).toEqualTypeOf<Promise<core.ResolvedValue<number>>>();
expectTypeOf(resolveValue<Promise<number>>(Promise.resolve(42))).toEqualTypeOf<
  Promise<core.ResolvedValue<number>>
>();
expectTypeOf(new SerialQueue().run<Promise<number>>(() => Promise.resolve(42))).toEqualTypeOf<
  Promise<core.ResolvedValue<number>>
>();

const capturedDeclaration = normalizePlainRecord(
  { name: "declared", payload: { value: 1 } },
  "Declaration",
);
expectTypeOf(capturedDeclaration).toEqualTypeOf<
  Readonly<{ name: string; payload: { value: number } }>
>();
// @ts-expect-error Accepted declaration fields are immutable.
capturedDeclaration.name = "replacement";
capturedDeclaration.payload.value = 2;

interface RecordFieldOptions {
  readonly required: string;
  readonly optional?: number;
}

const allowedFields = recordFields<RecordFieldOptions>()("required", "optional");
expectTypeOf(allowedFields).toEqualTypeOf<ReadonlySet<string>>();
type AlternativeRecordFieldOptions =
  RecordFieldOptions | { readonly required: string; readonly alternative: number };
recordFields<AlternativeRecordFieldOptions>()("required", "optional", "alternative");
// @ts-expect-error Every member's fields belong to a union declaration's accepted-field contract.
recordFields<AlternativeRecordFieldOptions>()("required");
// @ts-expect-error Optional declaration fields still belong to the accepted field contract.
recordFields<RecordFieldOptions>()("required");
// @ts-expect-error Required declaration fields cannot be omitted.
recordFields<RecordFieldOptions>()("optional");
// @ts-expect-error Unknown fields cannot widen the input contract.
recordFields<RecordFieldOptions>()("required", "optional", "unexpected");
const incompleteFields: (keyof RecordFieldOptions)[] = ["required"];
// @ts-expect-error An open-ended array cannot prove that every field was provided.
recordFields<RecordFieldOptions>()(...incompleteFields);
// @ts-expect-error Plain declaration fields are strings, so numeric keys are not representable.
recordFields<{ readonly 0: string }>()();
// @ts-expect-error An index signature cannot define a finite accepted-field set.
recordFields<Record<string, unknown>>()("required");

function rejectUncertainFields(
  field: keyof RecordFieldOptions,
  open: string,
  pattern: `field:${string}`,
) {
  // @ts-expect-error One runtime field cannot cover both members of its union type.
  recordFields<RecordFieldOptions>()(field);
  // @ts-expect-error A union element may repeat an existing field instead of supplying the missing one.
  recordFields<RecordFieldOptions>()("required", field);
  const widenedTuple = [open] as const;
  // @ts-expect-error A finite tuple of open strings cannot enumerate an index signature.
  recordFields<Record<string, unknown>>()(...widenedTuple);
  const patternTuple = [pattern] as const;
  // @ts-expect-error A template index signature also denotes an open field range.
  recordFields<Record<`field:${string}`, unknown>>()(...patternTuple);
}
void rejectUncertainFields;

type PlainService = { readonly id: "plain"; readonly kind: "service" };
type PlainOptional = {
  readonly kind: "optional";
  readonly service: core.Service<unknown>;
};

expectTypeOf<PlainService extends core.Service<unknown> ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  PlainOptional extends core.OptionalService<unknown> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<PlainService extends core.Requirement ? true : false>().toEqualTypeOf<false>();
expectTypeOf<PlainOptional extends core.Requirement ? true : false>().toEqualTypeOf<false>();
// @ts-expect-error Requirement is an identity union, not a value-typed Contract.
expectTypeOf<core.Requirement<string>>();

interface Entity {
  readonly id: string;
}

interface User extends Entity {
  readonly email: string;
}

expectTypeOf<core.Service<User>>().toMatchTypeOf<core.Requirement>();
expectTypeOf<core.OptionalService<User>>().toMatchTypeOf<core.Requirement>();
expectTypeOf<core.Provisions>().toEqualTypeOf<
  Readonly<Record<string, Extract<core.Requirement, { readonly kind: "service" }>>>
>();
expectTypeOf<core.ContractValue<core.Service<User>>>().toEqualTypeOf<User>();
expectTypeOf<core.ResolvedRequirement<core.Service<User>>>().toEqualTypeOf<User>();
expectTypeOf<core.ProvidedServices<{ readonly user: core.Service<User> }>>().toEqualTypeOf<{
  readonly user: User;
}>();
expectTypeOf<
  core.Service<User> extends core.Service<Entity> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.Service<Entity> extends core.Service<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.ExtensionPoint<User> extends core.ExtensionPoint<Entity> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.ExtensionPoint<Entity> extends core.ExtensionPoint<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<core.Event<User> extends core.Event<Entity> ? true : false>().toEqualTypeOf<false>();
expectTypeOf<core.Event<Entity> extends core.Event<User> ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  core.OptionalService<User> extends core.OptionalService<Entity> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.OptionalService<Entity> extends core.OptionalService<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.Contribution<User> extends core.Contribution<Entity> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.Contribution<Entity> extends core.Contribution<User> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<ReturnType<core.ContributionView<User>["get"]>>().toEqualTypeOf<
  ReadonlyArray<string>
>();
expectTypeOf<
  core.ContributionView<User> extends core.ContributionView<Entity> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  core.ContributionView<Entity> extends core.ContributionView<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  SnapshotPublisher<User> extends SnapshotPublisher<Entity> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  SnapshotPublisher<Entity> extends SnapshotPublisher<User> ? true : false
>().toEqualTypeOf<false>();

const CONFIGURATION = core.service<string>("surface/configuration");
const configured = core.definePlugin({
  name: "surface.configured",
  requires: { configuration: CONFIGURATION },
  setup(context) {
    expectTypeOf(context.dependencies.configuration).toEqualTypeOf<string>();
    // @ts-expect-error Dependencies have their own explicit namespace.
    void context.configuration;
  },
});
const plugins: readonly core.AnyPlugin[] = [configured];
expectTypeOf(plugins[0]).toEqualTypeOf<core.AnyPlugin | undefined>();
expectTypeOf<
  core.AnyPlugin extends Parameters<typeof core.definePlugin>[0] ? true : false
>().toEqualTypeOf<false>();

const schema: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "surface",
    validate: (input) => ({ value: Number(input) }),
  },
};
const parsed = core.definePlugin({
  name: "surface.parsed-configuration",
  configuration: schema,
  setup(_context, value) {
    expectTypeOf(value).toEqualTypeOf<number>();
    void value.toFixed();
  },
});
expectTypeOf<
  core.Installation<typeof parsed> extends core.Installation ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.Installation extends core.Installation<typeof parsed> ? true : false
>().toEqualTypeOf<false>();
type ManagedInstallation = Pick<core.Installation, "id" | "status" | "origin">;
expectTypeOf<core.Installation<typeof parsed>>().toMatchTypeOf<ManagedInstallation>();
// @ts-expect-error Installation's only parameter is its Plugin declaration.
expectTypeOf<core.Installation<number>>();

const verifyInstallationTypes = (
  host: core.Host,
  change: core.ChangeSet,
  erased: core.AnyPlugin,
) => {
  // @ts-expect-error Structural commands belong to ChangeSet.
  host.install(parsed);
  // @ts-expect-error Installation requires an explicit stable identity.
  change.install(parsed);
  // @ts-expect-error Schema input is required.
  change.install(parsed, { id: "parsed" });
  // @ts-expect-error Schema input is string, not its transformed number output.
  change.install(parsed, { id: "parsed", configuration: 42 });

  const precise = change.install(parsed, { id: "parsed", configuration: "42" });
  expectTypeOf(precise).toEqualTypeOf<core.Installation<typeof parsed>>();
  change.update(precise, { configuration: "43" });
  // @ts-expect-error Updates preserve the Installation declaration's input type.
  change.update(precise, { configuration: 43 });
  // @ts-expect-error Read-only identities cannot independently change committed state.
  precise.update({ configuration: "44" });
  // @ts-expect-error Origin cannot be advanced separately from its implementation.
  change.update(precise, { configuration: "44", origin: { revision: "new" } });
  change.update(precise, { plugin: parsed, origin: { revision: "new" } });

  const installation = change.install(erased, { id: "erased", configuration: undefined });
  change.update(installation, { plugin: erased });
  change.remove(installation);
  expectTypeOf(host.use(CONFIGURATION, (value) => value.length)).toEqualTypeOf<
    Promise<core.ResolvedValue<number>>
  >();
  expectTypeOf(host.use(core.optional(CONFIGURATION), (value) => value?.length)).toEqualTypeOf<
    Promise<core.ResolvedValue<number | undefined>>
  >();
  expectTypeOf(
    host.use<string, Promise<number>>(CONFIGURATION, () => Promise.resolve(42)),
  ).toEqualTypeOf<Promise<core.ResolvedValue<number>>>();
  expectTypeOf(host.plan(change)).toEqualTypeOf<Promise<core.Plan>>();
};
void verifyInstallationTypes;

const text = core.definePlugin<string>({ name: "initial.text", setup() {} });
const number = core.definePlugin<number>({ name: "initial.number", setup() {} });
const unconfigured = core.definePlugin({ name: "initial.unconfigured", setup() {} });
const optional = core.definePlugin<string | undefined>({ name: "initial.optional", setup() {} });
const unknown = core.definePlugin<unknown>({ name: "initial.unknown", setup() {} });

expectTypeOf(core.createHost()).toEqualTypeOf<core.Host>();
core.createHost({ name: "empty", installations: [] });
core.createHost({
  installations: [
    { id: "text", plugin: text, configuration: "text" },
    { id: "number", plugin: number, configuration: 42 },
    { id: "parsed", plugin: parsed, configuration: "42" },
    { id: "unconfigured", plugin: unconfigured },
    { id: "explicit-void", plugin: unconfigured, configuration: undefined },
    { id: "optional", plugin: optional },
    { id: "explicit-optional", plugin: optional, configuration: "text" },
    { id: "unknown", plugin: unknown },
    { id: "explicit-unknown", plugin: unknown, configuration: { value: 42 } },
  ],
});

// @ts-expect-error Initial configuration is required when the Plugin input excludes undefined.
core.createHost({ installations: [{ id: "text", plugin: text }] });
// @ts-expect-error Configuration cannot widen the Plugin inferred from its own declaration.
core.createHost({ installations: [{ id: "text", plugin: text, configuration: 42 }] });
// @ts-expect-error Setup's transformed output cannot replace the schema's input.
core.createHost({ installations: [{ id: "parsed", plugin: parsed, configuration: 42 }] });
// @ts-expect-error Void does not authorize arbitrary configuration.
core.createHost({ installations: [{ id: "void", plugin: unconfigured, configuration: "text" }] });
// @ts-expect-error An optional input remains constrained when provided.
core.createHost({ installations: [{ id: "optional", plugin: optional, configuration: 42 }] });

const initial: core.InitialInstallation<typeof parsed> = {
  id: "parsed",
  plugin: parsed,
  configuration: "42",
  groupId: "workspace",
  origin: { revision: "initial" },
};
core.createHost({ groups: [{ id: "workspace" }], installations: [initial] });
// @ts-expect-error Explicit InitialInstallation annotations preserve required schema input.
const missingInitial: core.InitialInstallation<typeof parsed> = { id: "parsed", plugin: parsed };
void missingInitial;

const options: core.HostOptions<readonly [typeof text, typeof number]> = {
  installations: [
    { id: "text", plugin: text, configuration: "text" },
    { id: "number", plugin: number, configuration: 42 },
  ],
};
core.createHost(options);

const mixed = [
  { id: "text", plugin: text, configuration: "text" },
  { id: "number", plugin: number, configuration: 42 },
];
core.createHost({ installations: mixed });
const readonlyMixed = [
  { id: "text", plugin: text, configuration: "text" },
  { id: "number", plugin: number, configuration: 42 },
] as const;
core.createHost({ installations: readonlyMixed });

const crossed = [
  { id: "text", plugin: text, configuration: 42 },
  { id: "number", plugin: number, configuration: "text" },
];
// @ts-expect-error A heterogeneous array must retain each Plugin's own input, not their union.
core.createHost({ installations: crossed });
const readonlyCrossed = [
  { id: "text", plugin: text, configuration: 42 },
  { id: "number", plugin: number, configuration: "text" },
] as const;
// @ts-expect-error Readonly tuples must not admit cross-paired configuration either.
core.createHost({ installations: readonlyCrossed });

function verifyDynamicInput(plugin: core.AnyPlugin, input: unknown) {
  const options: core.HostOptions = {
    installations: [{ id: "dynamic", plugin, configuration: input }],
  };
  core.createHost(options);
  core.createHost({ installations: [{ id: "dynamic", plugin }] });
}
void verifyDynamicInput;

function rejectUncorrelatedInput(plugin: typeof text | typeof number) {
  // @ts-expect-error A union Plugin does not establish which configuration input applies.
  core.createHost({ installations: [{ id: "uncertain", plugin, configuration: "text" }] });
  const change = core.createHost().change();
  // @ts-expect-error Separate union parameters do not establish a Plugin/input pairing.
  change.install(plugin, { id: "uncertain", configuration: "text" });
  // @ts-expect-error Explicit arguments must preserve the same pairing.
  change.install<core.InstallationArguments<typeof plugin>>(plugin, {
    id: "explicit-uncertain",
    configuration: "text",
  });
}
void rejectUncorrelatedInput;

const change = core.createHost().change();
change.install(unconfigured, { id: "void" });
change.install(optional, { id: "optional" });
change.install(unknown, { id: "unknown" });
change.install(unconfigured, { id: "explicit-void", configuration: undefined });
change.install(optional, { id: "explicit-optional", configuration: "text" });
change.install(unknown, { id: "explicit-unknown", configuration: { value: 42 } });
// @ts-expect-error ChangeSet uses the same required-input rule as initial declarations.
change.install(text, { id: "required" });
// @ts-expect-error Optional configuration cannot widen the declared input.
change.install(optional, { id: "wrong-optional", configuration: 42 });
// @ts-expect-error Void does not authorize arbitrary configuration.
change.install(unconfigured, { id: "wrong-void", configuration: "text" });

function rejectUncorrelatedOptionalInput(plugin: typeof text | typeof unconfigured) {
  // @ts-expect-error A void branch cannot make another Plugin's required input optional.
  change.install(plugin, { id: "uncertain-optional" });
}
void rejectUncorrelatedOptionalInput;

function verifyCorrelatedInstallation(
  declaration: core.InstallationArguments<typeof text | typeof number>,
  readonlyDeclaration:
    | readonly [typeof text, core.InstallationOptions<typeof text>]
    | readonly [typeof number, core.InstallationOptions<typeof number>],
  optionalDeclaration: core.InstallationArguments<typeof text | typeof unconfigured>,
) {
  const installation = change.install(...declaration);
  expectTypeOf(installation).toEqualTypeOf<core.Installation<typeof text | typeof number>>();
  expectTypeOf(change.install(...readonlyDeclaration)).toEqualTypeOf<
    core.Installation<typeof text | typeof number>
  >();
  change.install<core.InstallationArguments<typeof text | typeof number>>(...declaration);
  change.remove(installation);

  // @ts-expect-error The handle does not identify which installed branch accepts this input.
  change.update(installation, { configuration: "text" });
  // @ts-expect-error Explicit Plugin unions do not identify the installed branch either.
  change.update<typeof text | typeof number>(installation, { configuration: 42 });
  // @ts-expect-error Replacement cannot inherit input from an unknown installed branch.
  change.update(installation, { plugin: text });
  change.update(installation, { plugin: text, configuration: "replacement" });
  change.update(installation, { plugin: number, configuration: 42 });
  // @ts-expect-error Replacement input remains paired with its own Plugin.
  change.update(installation, { plugin: text, configuration: 42 });

  const optionalInstallation = change.install(...optionalDeclaration);
  // @ts-expect-error A void branch does not authorize dropping the installed branch's input.
  change.update(optionalInstallation, { configuration: undefined });
  // @ts-expect-error Omitting replacement configuration would retain a possible string input.
  change.update(optionalInstallation, { plugin: unconfigured });
  change.update(optionalInstallation, { plugin: unconfigured, configuration: undefined });
}
void verifyCorrelatedInstallation;

const explicitInstallation = change.install<core.InstallationArguments<typeof parsed>>(parsed, {
  id: "explicit-parsed",
  configuration: "42",
});
expectTypeOf(explicitInstallation).toEqualTypeOf<core.Installation<typeof parsed>>();
change.update<typeof parsed>(explicitInstallation, { configuration: "43" });
// @ts-expect-error Explicit arguments still require schema input, not setup output.
change.install<core.InstallationArguments<typeof parsed>>(parsed, {
  id: "explicit-wrong-schema-input",
  configuration: 42,
});
// @ts-expect-error The explicit type parameter describes a complete argument tuple.
change.install<typeof parsed>(parsed, { id: "obsolete-type-argument", configuration: "42" });

const unionInput = core.definePlugin<string | number>({ name: "input.union", setup() {} });
const unionInputInstallation = change.install(unionInput, {
  id: "union-input",
  configuration: "text",
});
change.update(unionInputInstallation, { configuration: 42 });
change.update(unionInputInstallation, { plugin: unionInput, configuration: "text" });

function rejectOverlappingInput(plugin: typeof text | typeof unionInput) {
  // @ts-expect-error The string-only Plugin branch does not accept a number.
  change.install(plugin, { id: "overlapping-input", configuration: 42 });
}
void rejectOverlappingInput;

const broadInputSchema: StandardSchemaV1<string | number, number> = {
  "~standard": {
    version: 1,
    vendor: "surface",
    validate: (input) => ({ value: Number(input) }),
  },
};
const parsedBroadInput = core.definePlugin({
  name: "input.parsed-broad",
  configuration: broadInputSchema,
  setup(_context, configuration) {
    expectTypeOf(configuration).toEqualTypeOf<number>();
  },
});
expectTypeOf<typeof parsed extends typeof parsedBroadInput ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  core.Plugin<number, {}, {}, string> extends core.Plugin<number, {}, {}, string | number>
    ? true
    : false
>().toEqualTypeOf<false>();

function verifyOverlappingSchemaInputs(
  plugin: typeof parsed | typeof parsedBroadInput,
  useNarrowInput: boolean,
) {
  // @ts-expect-error Equal schema outputs cannot widen a declared Plugin union's input.
  change.install(plugin, { id: "declared-overlapping-schema", configuration: 42 });
  const selected = useNarrowInput ? parsed : parsedBroadInput;
  // @ts-expect-error Schema input covariance cannot collapse an inferred Plugin union.
  change.install(selected, { id: "inferred-overlapping-schema", configuration: 42 });
  // @ts-expect-error Initial declarations use the same invariant schema input contract.
  core.createHost({ installations: [{ id: "overlapping-schema", plugin, configuration: 42 }] });

  const declaration: core.InstallationArguments<typeof parsed | typeof parsedBroadInput> =
    useNarrowInput
      ? [parsed, { id: "paired-schema", configuration: "42" }]
      : [parsedBroadInput, { id: "paired-schema", configuration: 42 }];
  const installation = change.install(...declaration);
  change.update(installation, { configuration: "43" });
  // @ts-expect-error The update cannot widen the handle to the broader schema input branch.
  change.update(installation, { configuration: 43 });
  change.update(installation, { plugin: parsedBroadInput });
  // @ts-expect-error A narrow replacement cannot inherit every possible previous input.
  change.update(installation, { plugin: parsed });
  change.update(installation, { plugin: parsed, configuration: "43" });

  const narrow = change.install(parsed, { id: "narrow-schema", configuration: "42" });
  // @ts-expect-error A replacement cannot widen the Plugin inferred from the Installation.
  change.update(narrow, { plugin: parsedBroadInput, configuration: 43 });
}
void verifyOverlappingSchemaInputs;

const requiringText = core.definePlugin({
  name: "input.requiring-text",
  requires: { configuration: CONFIGURATION },
  setup(_context, _configuration: string) {},
});
function verifySharedInput(installation: core.Installation<typeof text | typeof requiringText>) {
  change.update(installation, { configuration: "text" });
  change.update(installation, { plugin: text });
  change.update(installation, { plugin: requiringText });
}
void verifySharedInput;

const leftInput = core.definePlugin<"left" | "shared">({ name: "input.left", setup() {} });
const rightInput = core.definePlugin<"right" | "shared">({ name: "input.right", setup() {} });
function verifySharedLiteralInput(
  declaration: core.InstallationArguments<typeof leftInput | typeof rightInput>,
) {
  const installation = change.install(...declaration);
  change.update(installation, { configuration: "shared" });
  // @ts-expect-error The right Plugin cannot consume the left-only input.
  change.update(installation, { configuration: "left" });
  // @ts-expect-error The left Plugin cannot consume the right-only input.
  change.update(installation, { configuration: "right" });
}
void verifySharedLiteralInput;

const optionalNumber = core.definePlugin<number | undefined>({
  name: "input.optional-number",
  setup() {},
});
function verifySharedOptionalInput(
  installation: core.Installation<typeof optional | typeof optionalNumber>,
) {
  change.update(installation, { configuration: undefined });
  // @ts-expect-error The optional string branch still rejects a number.
  change.update(installation, { configuration: 42 });
  // @ts-expect-error The optional number branch still rejects a string.
  change.update(installation, { configuration: "text" });
}
void verifySharedOptionalInput;

const structuredInput = core.definePlugin<{
  mode: "text" | "number";
  pair: [string, number];
}>({ name: "input.structured", setup() {} });
change.install(structuredInput, {
  id: "structured-input",
  configuration: { mode: "text", pair: ["text", 42] },
});

const defaultingSchema: StandardSchemaV1<string | undefined, number> = {
  "~standard": {
    version: 1,
    vendor: "surface",
    validate: (input) => ({ value: Number(input ?? 0) }),
  },
};
const defaulting = core.definePlugin({
  name: "input.defaulting",
  configuration: defaultingSchema,
  setup(_context, value) {
    expectTypeOf(value).toEqualTypeOf<number>();
  },
});
change.install(defaulting, { id: "defaulting" });
change.install(defaulting, { id: "explicit-defaulting", configuration: "42" });
// @ts-expect-error Schema defaults do not authorize setup output as installation input.
change.install(defaulting, { id: "wrong-defaulting", configuration: 42 });

declare const configurationBrand: unique symbol;
type BrandedNumber = number & { readonly [configurationBrand]: "port" };
type BrandedString = string & { readonly [configurationBrand]: "label" };
type BrandedBoolean = boolean & { readonly [configurationBrand]: "enabled" };

function verifyReadonlyConfigurationTypes(
  brandedSchema: StandardSchemaV1<
    string,
    { port: BrandedNumber; label: BrandedString; enabled: BrandedBoolean }
  >,
) {
  interface ConfigurationInput {
    source: string;
    labels: string[];
  }

  interface ConfigurationOutput {
    nested: { limit: number };
    values: number[];
    pair: [name: string, options: { enabled: boolean }];
    optional?: { names: string[] };
    choice:
      { mode: "automatic"; retry: { attempts: number } } | { mode: "manual"; schedule: string[] };
  }

  type ReadonlyOutput = {
    readonly nested: { readonly limit: number };
    readonly values: readonly number[];
    readonly pair: readonly [name: string, options: { readonly enabled: boolean }];
    readonly optional?: { readonly names: readonly string[] };
    readonly choice:
      | { readonly mode: "automatic"; readonly retry: { readonly attempts: number } }
      | { readonly mode: "manual"; readonly schedule: readonly string[] };
  };

  const output: ConfigurationOutput = {
    nested: { limit: 1 },
    values: [1],
    pair: ["primary", { enabled: true }],
    choice: { mode: "automatic", retry: { attempts: 2 } },
  };
  const schema: StandardSchemaV1<ConfigurationInput, ConfigurationOutput> = {
    "~standard": { version: 1, vendor: "configuration-types", validate: () => ({ value: output }) },
  };
  const configured = core.definePlugin({
    name: "configuration.readonly-output",
    configuration: schema,
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<ReadonlyOutput>();
      expectTypeOf(configuration.values.map((value) => value + 1)).toEqualTypeOf<number[]>();
      // @ts-expect-error Setup cannot replace captured record fields.
      configuration.nested = { limit: 2 };
      // @ts-expect-error Nested captured data does not grant mutation authority.
      configuration.nested.limit++;
      // @ts-expect-error Captured arrays expose no mutating methods.
      configuration.values.push(2);
      // @ts-expect-error Tuple positions are captured data too.
      configuration.pair[0] = "replacement";
      // @ts-expect-error Tuple members retain the same deep readonly boundary.
      configuration.pair[1].enabled = false;
      if (configuration.optional) {
        expectTypeOf(configuration.optional.names).toEqualTypeOf<readonly string[]>();
        // @ts-expect-error Optional fields do not bypass nested readonly capture.
        configuration.optional.names.push("replacement");
      }
      if (configuration.choice.mode === "automatic") {
        expectTypeOf(configuration.choice.retry.attempts).toEqualTypeOf<number>();
        // @ts-expect-error Union narrowing preserves the readonly output view.
        configuration.choice.retry.attempts = 3;
      } else {
        expectTypeOf(configuration.choice.schedule).toEqualTypeOf<readonly string[]>();
        // @ts-expect-error Every configuration union branch is deeply readonly.
        configuration.choice.schedule.push("later");
      }
    },
  });

  expectTypeOf<
    StandardSchemaV1.InferInput<NonNullable<typeof configured.configuration>>
  >().toEqualTypeOf<ConfigurationInput>();
  expectTypeOf<
    StandardSchemaV1.InferOutput<NonNullable<typeof configured.configuration>>
  >().toEqualTypeOf<ConfigurationOutput>();
  expectTypeOf<
    core.InstallationOptions<typeof configured>["configuration"]
  >().toEqualTypeOf<ConfigurationInput>();
  expectTypeOf<Parameters<typeof configured.setup>[1]>().toEqualTypeOf<ReadonlyOutput>();

  const input: ConfigurationInput = { source: "primary", labels: ["one"] };
  input.labels.push("two");
  output.values.push(2);
  const host = core.createHost({
    installations: [{ id: "configured", plugin: configured, configuration: input }],
  });
  const change = host.change();
  const installation = change.install(configured, { id: "replacement", configuration: input });
  change.update(installation, { configuration: input });
  change.update(installation, { plugin: configured, configuration: input });
  // @ts-expect-error Readonly setup output cannot replace the schema's distinct input.
  change.install(configured, { id: "wrong-input", configuration: output });
  // @ts-expect-error Required schema input remains required.
  change.install(configured, { id: "missing-input" });
  // @ts-expect-error Configuration-only updates still require schema input.
  change.update(installation, { configuration: output });

  interface PlainConfiguration {
    port: number;
    endpoints: { path: string }[];
  }

  const schemaFree = core.definePlugin<PlainConfiguration>({
    name: "configuration.schema-free",
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<{
        readonly port: number;
        readonly endpoints: ReadonlyArray<{ readonly path: string }>;
      }>();
      // @ts-expect-error A schema-free declaration has the same captured output boundary.
      configuration.port++;
      // @ts-expect-error Plain interfaces do not need an index signature to become deeply readonly.
      configuration.endpoints[0]!.path = "replacement";
    },
  });
  expectTypeOf<
    core.InstallationOptions<typeof schemaFree>["configuration"]
  >().toEqualTypeOf<PlainConfiguration>();
  change.install(schemaFree, { id: "schema-free", configuration: { port: 8080, endpoints: [] } });
  // @ts-expect-error Schema absence does not make a typed configuration input optional.
  change.install(schemaFree, { id: "missing-schema-free-input" });

  const annotated: core.Plugin<ConfigurationOutput, {}, {}, ConfigurationInput> = {
    name: "configuration.annotated",
    configuration: schema,
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<ReadonlyOutput>();
      // @ts-expect-error Direct Plugin annotations expose the same readonly output as core.definePlugin.
      configuration.values.splice(0, 1);
    },
  };
  change.install(annotated, { id: "annotated", configuration: input });

  const inferred = core.definePlugin({
    name: "configuration.inferred",
    setup(_context, configuration: { readonly port: number }) {
      expectTypeOf(configuration.port).toEqualTypeOf<number>();
    },
  });
  change.install(inferred, { id: "inferred", configuration: { port: 8080 } });
  // @ts-expect-error Inference from a setup annotation still preserves the configuration shape.
  change.install(inferred, { id: "wrong-inferred", configuration: "8080" });

  const defaultingSchema: StandardSchemaV1<ConfigurationInput | undefined, ConfigurationOutput> = {
    "~standard": { version: 1, vendor: "configuration-types", validate: () => ({ value: output }) },
  };
  const defaulting = core.definePlugin({
    name: "configuration.defaulting",
    configuration: defaultingSchema,
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<ReadonlyOutput>();
    },
  });
  change.install(defaulting, { id: "defaulting" });
  change.install(defaulting, { id: "defaulting-input", configuration: input });
  // @ts-expect-error Optional schema input does not accept the output type.
  change.install(defaulting, { id: "wrong-defaulting", configuration: output });

  const choice = core.definePlugin<ConfigurationOutput["choice"]>({
    name: "configuration.union",
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<ReadonlyOutput["choice"]>();
    },
  });
  change.install(choice, {
    id: "automatic",
    configuration: { mode: "automatic", retry: { attempts: 2 } },
  });
  change.install(choice, { id: "manual", configuration: { mode: "manual", schedule: [] } });

  const branded = core.definePlugin({
    name: "configuration.branded-primitives",
    configuration: brandedSchema,
    setup(_context, configuration) {
      expectTypeOf(configuration.port).toEqualTypeOf<BrandedNumber>();
      expectTypeOf(configuration.label).toEqualTypeOf<BrandedString>();
      expectTypeOf(configuration.enabled).toEqualTypeOf<BrandedBoolean>();
      expectTypeOf(configuration.port + 1).toEqualTypeOf<number>();
      expectTypeOf(configuration.label.toLowerCase()).toEqualTypeOf<string>();
    },
  });
  change.install(branded, { id: "branded", configuration: "input" });

  const unknown = core.definePlugin<unknown>({
    name: "configuration.unknown",
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<unknown>();
    },
  });
  const empty = core.definePlugin({
    name: "configuration.empty",
    setup(_context, configuration) {
      expectTypeOf(configuration).toEqualTypeOf<void>();
    },
  });
  change.install(unknown, { id: "unknown", configuration: input });
  change.install(empty, { id: "empty" });
}
void verifyReadonlyConfigurationTypes;

expectTypeOf<core.Installation["status"]>().toEqualTypeOf<core.InstallationState>();
expectTypeOf<core.HostSnapshot["error"]>().toEqualTypeOf<core.ErrorSnapshot | undefined>();
expectTypeOf<ReturnType<core.ChangeSet["update"]>>().toEqualTypeOf<void>();
expectTypeOf<ReturnType<core.ChangeSet["remove"]>>().toEqualTypeOf<void>();
// @ts-expect-error Ownership groups do not duplicate execution state.
expectTypeOf<core.Group["status"]>();
// @ts-expect-error Live service references must be borrowed.
expectTypeOf<core.Host["get"]>();
// @ts-expect-error Snapshot reads and subscriptions share one diagnostics view.
expectTypeOf<core.Host["inspect"]>();
expectTypeOf<ReturnType<core.Host["diagnostics"]["get"]>>().toEqualTypeOf<core.HostSnapshot>();
expectTypeOf<core.ApplyResult>().toEqualTypeOf<{
  readonly stateRevision: number;
  readonly affectedInstallations: ReadonlyArray<string>;
}>();
expectTypeOf<core.Plan["report"]["baseStateRevision"]>().toEqualTypeOf<number>();
expectTypeOf<core.Disposable>().toMatchTypeOf<Disposable>();
expectTypeOf<Disposable>().toMatchTypeOf<core.Disposable>();
expectTypeOf<core.AsyncDisposable>().toMatchTypeOf<AsyncDisposable>();
expectTypeOf<AsyncDisposable>().toMatchTypeOf<core.AsyncDisposable>();

type NarrowLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};
expectTypeOf<NarrowLogger extends core.Logger ? true : false>().toEqualTypeOf<false>();

function verifyLoggerReturns(dynamicLogger: unknown) {
  const synchronousMethod: () => void = () => undefined;
  const synchronousLogger: core.Logger = {
    debug: synchronousMethod,
    info: synchronousMethod,
    warn: synchronousMethod,
    error: synchronousMethod,
  };
  const asynchronousMethod = async () => undefined;
  core.createHost({ logger: synchronousLogger });
  core.createHost({ logger: captureLogger(synchronousLogger) });
  core.createHost({ logger: console });
  core.createHost({ logger: captureLogger(console) });
  // @ts-expect-error Instance debug calls cannot return an asynchronous result.
  core.createHost({ logger: { ...synchronousLogger, debug: asynchronousMethod } });
  // @ts-expect-error Instance info calls cannot return an asynchronous result.
  core.createHost({ logger: { ...synchronousLogger, info: asynchronousMethod } });
  // @ts-expect-error Instance warning calls cannot return an asynchronous result.
  core.createHost({ logger: { ...synchronousLogger, warn: asynchronousMethod } });
  // @ts-expect-error Instance error calls cannot return an asynchronous result.
  core.createHost({ logger: { ...synchronousLogger, error: asynchronousMethod } });

  const captured = captureLogger({
    debug: synchronousMethod,
    info: Object.assign(() => "recorded" as const, { backend: true }),
    warn: synchronousMethod,
    error: asynchronousMethod,
  });
  expectTypeOf<ReturnType<typeof captured.debug>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<typeof captured.info>>().toEqualTypeOf<"recorded">();
  expectTypeOf<ReturnType<typeof captured.error>>().toEqualTypeOf<Promise<undefined>>();
  // @ts-expect-error Captured methods do not retain the backend function's own properties.
  void captured.info.backend;
  // @ts-expect-error Capturing mixed methods must not erase an asynchronous return to void.
  core.createHost({ logger: captured });

  const capturedDynamic = captureLogger(dynamicLogger);
  expectTypeOf<ReturnType<typeof capturedDynamic.error>>().toEqualTypeOf<unknown>();
  // @ts-expect-error Capturing method shape cannot prove unknown calls will be synchronous.
  core.createHost({ logger: capturedDynamic });
  if (core.isLogger(dynamicLogger)) {
    expectTypeOf<ReturnType<typeof dynamicLogger.error>>().toEqualTypeOf<unknown>();
    // @ts-expect-error A shape guard cannot prove unknown calls will be synchronous.
    core.createHost({ logger: dynamicLogger });
  }
}
void verifyLoggerReturns;

expectTypeOf<NonNullable<core.HostOptions["onError"]>>().toEqualTypeOf<
  (error: unknown) => core.Awaitable<void>
>();

expectTypeOf<ReturnType<core.LifetimeContext["child"]>>().toEqualTypeOf<core.ChildLifetime>();
expectTypeOf<core.ResolvedValue<number>>().toEqualTypeOf<{ readonly value: number }>();
expectTypeOf<core.Task<number>["result"]>().toEqualTypeOf<Promise<core.ResolvedValue<number>>>();
const verifyResultTypes = (lifetime: core.LifetimeContext, values: core.ContributionView<User>) => {
  expectTypeOf(lifetime.spawn(() => 1).result).toEqualTypeOf<Promise<core.ResolvedValue<number>>>();
  expectTypeOf(lifetime.spawn(async () => 1).result).toEqualTypeOf<
    Promise<core.ResolvedValue<number>>
  >();
  expectTypeOf(lifetime.spawn<Promise<number>>(() => Promise.resolve(42)).result).toEqualTypeOf<
    Promise<core.ResolvedValue<number>>
  >();
  expectTypeOf(values.use("user", (user) => user.email)).toEqualTypeOf<
    Promise<core.ResolvedValue<string>>
  >();
  expectTypeOf(values.use("user", async (user) => user.email)).toEqualTypeOf<
    Promise<core.ResolvedValue<string>>
  >();
  expectTypeOf(values.use<Promise<number>>("user", () => Promise.resolve(42))).toEqualTypeOf<
    Promise<core.ResolvedValue<number>>
  >();
};
void verifyResultTypes;
expectTypeOf<core.ChildLifetime>().toMatchTypeOf<core.AsyncDisposable>();
// @ts-expect-error An Instance's shutdown authority belongs to its Engine.
expectTypeOf<core.LifetimeContext[typeof Symbol.asyncDispose]>();

type NarrowLifetime = Omit<core.LifetimeContext, "child"> & {
  readonly child: (label: "known") => core.ChildLifetime;
};
expectTypeOf<NarrowLifetime extends core.LifetimeContext ? true : false>().toEqualTypeOf<false>();
expectTypeOf<core.EventArguments<void>>().toEqualTypeOf<[payload?: void]>();

const descriptiveSchema: StandardSchemaV1<string, number> & StandardJSONSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "surface",
    validate: (input) => ({ value: Number(input) }),
    jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "number" }) },
  },
};
const descriptive = core.definePlugin({
  name: "surface.descriptive",
  configuration: descriptiveSchema,
  setup(_context, configuration) {
    expectTypeOf(configuration).toEqualTypeOf<number>();
  },
});
const description = core.describePlugin(descriptive);
expectTypeOf(description).toEqualTypeOf<core.PluginDescriptor>();
if (description.configuration.status === "available") {
  expectTypeOf(description.configuration.target).toEqualTypeOf<StandardJSONSchemaV1.Target>();
  expectTypeOf(description.configuration.input).toEqualTypeOf<
    Readonly<Record<string, core.ConfigurationValue>>
  >();
}

function verifyPluginDescriptorTypes() {
  type DescribedRequirement = core.PluginDescriptor["requires"][number];

  const requirements: ReadonlyArray<DescribedRequirement> = [
    { alias: "required", id: "description/required", kind: "service", optional: false },
    { alias: "optional", id: "description/optional", kind: "service", optional: true },
    {
      alias: "contributions",
      id: "description/contributions",
      kind: "extensionPoint",
      optional: false,
    },
  ];

  // @ts-expect-error Only Services can be optional requirements.
  const optionalExtensionPoint: DescribedRequirement = {
    alias: "invalid",
    id: "description/invalid",
    kind: "extensionPoint",
    optional: true,
  };

  function readRequirement(requirement: DescribedRequirement) {
    if (requirement.kind === "extensionPoint") {
      expectTypeOf(requirement.optional).toEqualTypeOf<false>();
    } else {
      expectTypeOf(requirement.optional).toEqualTypeOf<boolean>();
    }
  }

  const absent: core.PluginConfigurationDescriptor = { status: "schema_absent" };
  // @ts-expect-error Schema absence no longer claims that no configuration exists.
  const obsolete: core.PluginConfigurationDescriptor = { status: "none" };

  void requirements;
  void optionalExtensionPoint;
  void readRequirement;
  void absent;
  void obsolete;
}
void verifyPluginDescriptorTypes;

const plannedDeclaration: core.DeclarationSnapshot = { pluginName: "planned", origin: undefined };
// @ts-expect-error Required Service bindings always identify their provider in an executable graph.
const missingRequiredProvider: core.BindingReport = {
  installation: "planned",
  contract: "planned/value",
  optional: false,
  provider: undefined,
};
const unresolvedOptionalProvider: core.BindingReport = {
  installation: "planned",
  contract: "planned/value",
  optional: true,
  provider: undefined,
};
void missingRequiredProvider;
void unresolvedOptionalProvider;

function verifyBindingProvider(binding: core.BindingReport) {
  if (binding.optional) {
    expectTypeOf(binding.provider).toEqualTypeOf<string | undefined>();
  } else {
    expectTypeOf(binding.provider).toEqualTypeOf<string>();
  }
}
void verifyBindingProvider;

const missingInstalledDeclaration: core.PlanOperation = {
  kind: "install",
  id: "planned",
  before: undefined,
  // @ts-expect-error Installation requires the declaration that will be installed.
  after: undefined,
};
const retainedRemovedDeclaration: core.PlanOperation = {
  kind: "remove",
  id: "planned",
  before: plannedDeclaration,
  // @ts-expect-error Removal cannot have a declaration after the change.
  after: plannedDeclaration,
};
// @ts-expect-error Provider changes must identify their Contract.
const missingChangedContract: core.ImpactReason = {
  installation: "planned",
  kind: "provider_changed",
  provider: "provider",
};
// @ts-expect-error A provider change must identify at least one actual provider.
const missingChangedProviders: core.ImpactReason = {
  installation: "planned",
  kind: "provider_changed",
  contract: "planned/value",
};
// @ts-expect-error Direct declaration changes do not carry provider-change fields.
const providerOnDirectReason: core.ImpactReason = {
  installation: "planned",
  kind: "updated",
  provider: "provider",
};
void missingInstalledDeclaration;
void retainedRemovedDeclaration;
void missingChangedContract;
void missingChangedProviders;
void providerOnDirectReason;

function verifyReportCorrelations(operation: core.PlanOperation, reason: core.ImpactReason) {
  if (operation.kind === "install") {
    expectTypeOf(operation.before).toEqualTypeOf<undefined>();
    expectTypeOf(operation.after.pluginName).toEqualTypeOf<string>();
  } else if (operation.kind === "update") {
    expectTypeOf(operation.before.pluginName).toEqualTypeOf<string>();
    expectTypeOf(operation.after.pluginName).toEqualTypeOf<string>();
  } else if (operation.kind === "remove") {
    expectTypeOf(operation.before.pluginName).toEqualTypeOf<string>();
    expectTypeOf(operation.after).toEqualTypeOf<undefined>();
  }
  if (reason.kind === "provider_changed") {
    expectTypeOf(reason.contract.toUpperCase()).toEqualTypeOf<string>();
    expectTypeOf(reason.provider ?? reason.previousProvider).toEqualTypeOf<string>();
  } else {
    expectTypeOf(reason.contract).toEqualTypeOf<undefined>();
    expectTypeOf(reason.provider).toEqualTypeOf<undefined>();
    expectTypeOf(reason.previousProvider).toEqualTypeOf<undefined>();
  }
}
void verifyReportCorrelations;

function verifySynchronousSnapshotCallbacks(
  view: core.SnapshotView<number>,
  contributions: core.ContributionView<string>,
  asynchronous: PromiseLike<void>,
  uncertain: boolean,
  synchronous: () => void,
) {
  new SnapshotPublisher(() => 0, synchronous);
  new SnapshotPublisher<number>(() => 0, synchronous);
  new SnapshotPublisher(
    () => 0,
    (error) => {
      expectTypeOf(error).toEqualTypeOf<unknown>();
    },
  );
  new SnapshotPublisher(
    () => 0,
    // @ts-expect-error Snapshot error reporting must finish inside the failed notification.
    async () => undefined,
  );
  new SnapshotPublisher<number>(
    () => 0,
    // @ts-expect-error Explicit snapshot types cannot erase an asynchronous reporter result.
    async () => undefined,
  );
  new SnapshotPublisher(
    () => 0,
    // @ts-expect-error Structural PromiseLike reporters cannot extend the notification boundary.
    () => asynchronous,
  );
  new SnapshotPublisher(
    () => 0,
    // @ts-expect-error Snapshot error reporters perform side effects without a business result.
    () => 1,
  );

  view.subscribe(() => undefined);
  view.subscribe(() => 1);
  view.subscribe(() => (uncertain ? 1 : "unavailable"));
  view.subscribe(() => ({ pending: asynchronous }));
  view.subscribe(synchronous);
  view.subscribe<void>(synchronous);
  contributions.subscribe(() => undefined);
  batchSnapshotNotifications(() => undefined);
  batchSnapshotNotifications(() => 1);
  batchSnapshotNotifications(() => (uncertain ? 1 : "unavailable"));
  batchSnapshotNotifications(() => ({ pending: asynchronous }));
  batchSnapshotNotifications(synchronous);
  batchSnapshotNotifications<void>(synchronous);
  batchSnapshotNotifications(synchronous, synchronous);
  batchSnapshotNotifications(synchronous, (error) => {
    expectTypeOf(error).toEqualTypeOf<unknown>();
  });
  // @ts-expect-error A notification boundary must report synchronously.
  batchSnapshotNotifications(synchronous, async () => undefined);
  // @ts-expect-error Structural PromiseLike reporters cannot extend the boundary.
  batchSnapshotNotifications(synchronous, () => asynchronous);
  // @ts-expect-error A notification boundary reports failures without returning a business result.
  batchSnapshotNotifications(synchronous, () => 1);

  // @ts-expect-error Snapshot notifications cannot own an asynchronous subscriber continuation.
  view.subscribe(async () => undefined);
  // @ts-expect-error Explicit void cannot erase a visible asynchronous subscriber result.
  view.subscribe<void>(async () => undefined);
  // @ts-expect-error Structural PromiseLike callbacks cannot extend a snapshot notification.
  view.subscribe(() => asynchronous);
  // @ts-expect-error Every subscriber branch must finish within the notification boundary.
  view.subscribe(() => (uncertain ? undefined : asynchronous));
  // @ts-expect-error Contribution views use the same synchronous snapshot protocol.
  contributions.subscribe(async () => undefined);
  // @ts-expect-error A publication batch ends before an asynchronous callback settles.
  batchSnapshotNotifications(async () => undefined);
  // @ts-expect-error Explicit void cannot erase a visible asynchronous publication result.
  batchSnapshotNotifications<void>(async () => undefined);
  // @ts-expect-error Structural PromiseLike callbacks cannot extend the publication batch.
  batchSnapshotNotifications(() => asynchronous);
  // @ts-expect-error Every publication batch branch must finish before the batch is closed.
  batchSnapshotNotifications(() => (uncertain ? undefined : asynchronous));
}
void verifySynchronousSnapshotCallbacks;

function verifySnapshotThenableCallbacks(
  view: core.SnapshotView<number>,
  contributions: core.ContributionView<string>,
  completing: { readonly then: (fulfill: (value: number) => void) => void },
  optionalThen: { readonly then?: (fulfill: (value: number) => void) => void },
  mixedThen: { readonly then: string | ((fulfill: (value: number) => void) => void) },
  indexedThen: Readonly<Record<string, (fulfill: (value: number) => void) => void>>,
  textThenData: { readonly then: string },
  undefinedThenData: { readonly then: undefined },
  data: { readonly then?: string },
  uncertain: boolean,
) {
  view.subscribe(() => textThenData);
  view.subscribe(() => undefinedThenData);
  view.subscribe(() => data);
  view.subscribe(() => ({ pending: completing }));
  batchSnapshotNotifications(() => textThenData);
  batchSnapshotNotifications(() => undefinedThenData);
  batchSnapshotNotifications(() => data);
  batchSnapshotNotifications(() => ({ pending: completing }));

  // @ts-expect-error Runtime thenable adoption does not require PromiseLike's chained return type.
  view.subscribe(() => completing);
  // @ts-expect-error An optional callable then can still begin asynchronous work.
  view.subscribe(() => optionalThen);
  // @ts-expect-error Every possible then property must be non-callable at a synchronous boundary.
  view.subscribe(() => mixedThen);
  // @ts-expect-error A synchronous alternative does not authorize a thenable result.
  view.subscribe(() => (uncertain ? 0 : completing));
  // @ts-expect-error Contribution subscriptions share the SnapshotView thenable boundary.
  contributions.subscribe(() => completing);
  // @ts-expect-error A string index signature can also declare a callable then property.
  view.subscribe(() => indexedThen);
  // @ts-expect-error Publication must finish before any thenable continuation, regardless of its signature.
  batchSnapshotNotifications(() => completing);
  // @ts-expect-error Optional thenables cannot extend a publication batch.
  batchSnapshotNotifications(() => optionalThen);
  // @ts-expect-error A callable then branch cannot extend a publication batch.
  batchSnapshotNotifications(() => mixedThen);
  // @ts-expect-error An indexed callable then cannot extend a publication batch.
  batchSnapshotNotifications(() => indexedThen);
  // @ts-expect-error Every publication result branch must be synchronous.
  batchSnapshotNotifications(() => (uncertain ? undefined : completing));
}
void verifySnapshotThenableCallbacks;

function verifySynchronousAbortCallbacks(
  signal: AbortSignal,
  synchronous: () => void,
  pending: PromiseLike<void>,
  completing: { readonly then: (fulfill: (value: number) => void) => void },
  uncertain: boolean,
) {
  onAbort(signal, (reason) => {
    expectTypeOf(reason).toEqualTypeOf<unknown>();
  });
  onAbort(signal, synchronous);
  onAbort<void>(signal, synchronous);
  onAbort(signal, () => 1);
  onAbort(signal, () => (uncertain ? 1 : "cancelled"));
  onAbort(signal, () => ({ pending }));

  // @ts-expect-error Cancellation observation cannot own an asynchronous callback continuation.
  onAbort(signal, async () => undefined);
  // @ts-expect-error Explicit void cannot discard a visible Promise result.
  onAbort<void>(signal, async () => undefined);
  // @ts-expect-error A PromiseLike callback has the same asynchronous ownership requirement.
  onAbort(signal, () => pending);
  // @ts-expect-error Runtime thenables need no PromiseLike chained return to start asynchronous work.
  onAbort(signal, () => completing);
  // @ts-expect-error Every callback branch must finish before cancellation notification returns.
  onAbort(signal, () => (uncertain ? undefined : pending));
}
void verifySynchronousAbortCallbacks;

function verifyAcquiredResourceTypes(
  lifetime: core.LifetimeContext,
  structural: PromiseLike<core.Resource>,
  uncertain: boolean,
) {
  const synchronous = { value: 1, [Symbol.dispose]() {} };
  const asynchronous = { value: "value", async [Symbol.asyncDispose]() {} };
  const thenable = {
    // oxlint-disable-next-line unicorn/no-thenable -- Acquisition accepts the structural fulfillment protocol.
    then(fulfill: (resource: typeof synchronous) => void) {
      fulfill(synchronous);
    },
  };
  expectTypeOf(lifetime.acquire(() => synchronous)).toEqualTypeOf<
    Promise<{ readonly resource: typeof synchronous }>
  >();
  expectTypeOf(lifetime.acquire(async () => asynchronous)).toEqualTypeOf<
    Promise<{ readonly resource: typeof asynchronous }>
  >();
  expectTypeOf(lifetime.acquire(() => structural)).toEqualTypeOf<
    Promise<{ readonly resource: core.Resource }>
  >();
  expectTypeOf(lifetime.acquire(() => thenable)).toEqualTypeOf<
    Promise<{ readonly resource: typeof synchronous }>
  >();
  expectTypeOf(lifetime.acquire(() => (uncertain ? synchronous : asynchronous))).toEqualTypeOf<
    Promise<{ readonly resource: typeof synchronous | typeof asynchronous }>
  >();
  expectTypeOf(
    lifetime.acquire(() => (uncertain ? Promise.resolve(synchronous) : asynchronous)),
  ).toEqualTypeOf<Promise<{ readonly resource: typeof synchronous | typeof asynchronous }>>();
  expectTypeOf(
    lifetime.acquire<Promise<typeof synchronous>>(() => Promise.resolve(synchronous)),
  ).toEqualTypeOf<Promise<{ readonly resource: typeof synchronous }>>();

  const disposablePromise = Object.assign(Promise.resolve(1), { [Symbol.dispose]() {} });
  // @ts-expect-error Acquisition owns the fulfilled value, not a disposable Promise that delivers a number.
  lifetime.acquire(() => disposablePromise);
  // @ts-expect-error Explicit factory result types must also fulfill with a Resource.
  lifetime.acquire<typeof disposablePromise>(() => disposablePromise);
  // @ts-expect-error A valid synchronous alternative cannot hide a non-Resource fulfillment branch.
  lifetime.acquire(() => (uncertain ? synchronous : disposablePromise));
  // @ts-expect-error A primitive factory result has no resource protocol.
  lifetime.acquire(() => 1);
  // @ts-expect-error A primitive Promise result has no resource protocol.
  lifetime.acquire(() => Promise.resolve(1));
}
void verifyAcquiredResourceTypes;

function verifyGenericAcquisition<Value>(lifetime: core.LifetimeContext, value: Value) {
  const resource = { value, [Symbol.dispose]() {} };
  const acquired: Promise<{ readonly resource: typeof resource }> = lifetime.acquire(
    async () => resource,
  );
  return acquired;
}
void verifyGenericAcquisition;

function rejectUnprovenAcquisition<ResourceType extends core.Resource>(
  lifetime: core.LifetimeContext,
  resource: ResourceType,
) {
  // @ts-expect-error A Resource subtype may itself be a Promise that fulfills with a non-Resource value.
  lifetime.acquire(() => resource);
}
void rejectUnprovenAcquisition;

const projectedError: core.ErrorSnapshot = { name: "Error", message: "release failed" };
const registeredObligation: core.UnresolvedObligation = {
  kind: "cleanup",
  id: 1,
  error: projectedError,
};
const shutdownObligation: core.UnresolvedObligation = {
  kind: "shutdown",
  error: projectedError,
};
// @ts-expect-error A shutdown deadline has no ordinary registration identity.
const inventedShutdownIdentity: core.UnresolvedObligation = {
  kind: "shutdown",
  id: 0,
  error: projectedError,
};
// @ts-expect-error A registered release obligation must retain its own identity.
const missingRegistrationIdentity: core.UnresolvedObligation = {
  kind: "cleanup",
  error: projectedError,
};
void [
  registeredObligation,
  shutdownObligation,
  inventedShutdownIdentity,
  missingRegistrationIdentity,
];

function verifyObligationIdentity(obligation: core.UnresolvedObligation) {
  if (obligation.kind === "shutdown") {
    expectTypeOf(obligation.id).toEqualTypeOf<undefined>();
  } else {
    expectTypeOf(obligation.id).toEqualTypeOf<number>();
  }
}
void verifyObligationIdentity;

const suppressionPair: core.ErrorSnapshot = {
  name: "SuppressedError",
  message: "release failed while another error was pending",
  error: projectedError,
  suppressed: projectedError,
};
// @ts-expect-error Suppression diagnostics always retain both failures.
const missingSuppressed: core.ErrorSnapshot = { name: "Error", message: "", error: projectedError };
// @ts-expect-error The suppressed failure cannot exist without its paired primary failure.
const missingPrimary: core.ErrorSnapshot = {
  name: "Error",
  message: "",
  suppressed: projectedError,
};
void [suppressionPair, missingSuppressed, missingPrimary];

function verifySuppressionPair(snapshot: core.ErrorSnapshot) {
  if (snapshot.error !== undefined) {
    expectTypeOf(snapshot.suppressed).toEqualTypeOf<core.ErrorSnapshot>();
  } else {
    expectTypeOf(snapshot.suppressed).toEqualTypeOf<undefined>();
  }
}
void verifySuppressionPair;

const installationSnapshotFields = {
  id: "owner",
  groupId: undefined,
  pluginName: "owner",
  origin: undefined,
  requires: [],
  provides: [],
};
const lifetimeSnapshot: core.LifetimeSnapshot = {
  label: "owner",
  phase: "active",
  cleanups: 0,
  interrupts: 0,
  tasks: 0,
  acquisitions: 0,
  publications: 0,
  foreground: 0,
  unresolved: [],
  children: [],
};
const installationSnapshots: ReadonlyArray<core.InstallationSnapshot> = [
  { ...installationSnapshotFields, status: "running", generation: 1, lifetime: lifetimeSnapshot },
  { ...installationSnapshotFields, status: "changing", generation: 1, lifetime: lifetimeSnapshot },
  { ...installationSnapshotFields, status: "changing", generation: undefined, lifetime: undefined },
  { ...installationSnapshotFields, status: "stopped", generation: undefined, lifetime: undefined },
  {
    ...installationSnapshotFields,
    status: "quarantined",
    generation: undefined,
    lifetime: undefined,
  },
];
// @ts-expect-error Running diagnostics always project an existing Instance.
const missingRunningInstance: core.InstallationSnapshot = {
  ...installationSnapshotFields,
  status: "running",
  generation: undefined,
  lifetime: undefined,
};
// @ts-expect-error Generation and Lifetime must come from the same existing Instance.
const partialChangingInstance: core.InstallationSnapshot = {
  ...installationSnapshotFields,
  status: "changing",
  generation: 1,
  lifetime: undefined,
};
const pendingSnapshot: core.InstallationSnapshot = {
  ...installationSnapshotFields,
  // @ts-expect-error Pending identities are not members of the committed diagnostic collection.
  status: "pending",
  generation: undefined,
  lifetime: undefined,
};
const removedSnapshot: core.InstallationSnapshot = {
  ...installationSnapshotFields,
  // @ts-expect-error Removed identities are not members of the committed diagnostic collection.
  status: "removed",
  generation: undefined,
  lifetime: undefined,
};
void [
  installationSnapshots,
  missingRunningInstance,
  partialChangingInstance,
  pendingSnapshot,
  removedSnapshot,
];

function verifyInstallationSnapshot(snapshot: core.InstallationSnapshot) {
  if (snapshot.status === "running") {
    expectTypeOf(snapshot.generation).toEqualTypeOf<number>();
    expectTypeOf(snapshot.lifetime).toEqualTypeOf<core.LifetimeSnapshot>();
  }
  if (snapshot.status === "stopped" || snapshot.status === "quarantined") {
    expectTypeOf(snapshot.generation).toEqualTypeOf<undefined>();
    expectTypeOf(snapshot.lifetime).toEqualTypeOf<undefined>();
  }
  if (snapshot.generation !== undefined) {
    expectTypeOf(snapshot.lifetime).toEqualTypeOf<core.LifetimeSnapshot>();
  }
}
void verifyInstallationSnapshot;
