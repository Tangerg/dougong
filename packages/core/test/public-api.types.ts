import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf } from "vitest";
import * as core from "@dougongjs/core";

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
expectTypeOf<
  core.ContributionView<User> extends core.ContributionView<Entity> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  core.ContributionView<Entity> extends core.ContributionView<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.SnapshotPublisher<User> extends core.SnapshotPublisher<Entity> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  core.SnapshotPublisher<Entity> extends core.SnapshotPublisher<User> ? true : false
>().toEqualTypeOf<false>();

const CONFIG = core.service<string>("surface/config");
const configured = core.definePlugin({
  name: "surface.configured",
  requires: { config: CONFIG },
  setup(ctx) {
    void ctx.config;
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
  name: "surface.parsed-config",
  config: schema,
  setup(_ctx, value) {
    void value.toFixed();
  },
});
expectTypeOf<
  core.Installation<typeof parsed> extends core.Installation ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  core.Installation extends core.Installation<typeof parsed> ? true : false
>().toEqualTypeOf<false>();
type ManagedInstallation = Pick<core.Installation, "id" | "status" | "ready" | "remove">;
expectTypeOf<core.Installation<typeof parsed>>().toMatchTypeOf<ManagedInstallation>();
// @ts-expect-error Installation's only parameter is its Plugin declaration.
expectTypeOf<core.Installation<number>>();

const verifyInstallationTypes = (
  host: core.Host,
  change: core.ChangeSet,
  erased: core.AnyPlugin,
) => {
  // @ts-expect-error A precise Plugin cannot fall through to the erased config signature.
  host.install(parsed);
  // @ts-expect-error ChangeSet installation preserves the same required config input.
  change.install(parsed);

  const precise = host.install(parsed, "42");
  void precise.update({ config: "43" });
  // @ts-expect-error Updates retain the precise Plugin's config input type.
  void precise.update({ config: 43 });

  const installation = host.install(erased);
  void installation.update({ plugin: erased });
  change.update(installation, { plugin: erased });
};
void verifyInstallationTypes;

expectTypeOf<core.Group["status"]>().toEqualTypeOf<core.LifecycleStatus>();
expectTypeOf<core.Installation["status"]>().toEqualTypeOf<core.LifecycleStatus>();
expectTypeOf<core.InstallationSnapshot["error"]>().toEqualTypeOf<Error | undefined>();
expectTypeOf<core.Host>().toMatchTypeOf<core.Installer>();
expectTypeOf<core.Group>().toMatchTypeOf<core.Installer>();
expectTypeOf<core.ChangeSet["install"]>().toEqualTypeOf<core.Installer["install"]>();
expectTypeOf<ReturnType<core.ChangeSet["update"]>>().toEqualTypeOf<void>();
expectTypeOf<ReturnType<core.ChangeSet["remove"]>>().toEqualTypeOf<void>();
type OptionalGet = <T>(token: core.OptionalService<T>) => T | undefined;
expectTypeOf<core.Host["get"]>().toMatchTypeOf<OptionalGet>();

type NarrowLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};
expectTypeOf<NarrowLogger extends core.Logger ? true : false>().toEqualTypeOf<false>();

type NarrowLifetime = Omit<core.LifetimeOperations, "lifetime"> & {
  lifetime(label: "known"): core.LifetimeContext;
};
expectTypeOf<
  NarrowLifetime extends core.LifetimeOperations ? true : false
>().toEqualTypeOf<false>();
