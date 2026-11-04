import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf } from "vitest";
import * as core from "dougong";
import {
  normalizePlainRecord,
  recordFields,
  resolveValue,
  SerialQueue,
  type SnapshotPublisher,
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

const plannedDeclaration: core.DeclarationSnapshot = { pluginName: "planned", origin: undefined };
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
