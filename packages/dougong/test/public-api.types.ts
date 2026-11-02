import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf } from "vitest";
import * as core from "dougong";
import { normalizePlainRecord, recordFields, type SnapshotPublisher } from "dougong/advanced";

expectTypeOf<ConstructorParameters<typeof core.RecordedFailure>>().toEqualTypeOf<
  [error: unknown, fields?: ReadonlyArray<string>]
>();
expectTypeOf<typeof core.isError>().toEqualTypeOf<(value: unknown) => value is Error>();

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
  expectTypeOf(host.use(CONFIGURATION, (value) => value.length)).toEqualTypeOf<Promise<number>>();
  expectTypeOf(host.use(core.optional(CONFIGURATION), (value) => value?.length)).toEqualTypeOf<
    Promise<number | undefined>
  >();
  expectTypeOf(host.plan(change)).toEqualTypeOf<Promise<core.Plan>>();
};
void verifyInstallationTypes;

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
