import { type AnyPlugin, definePlugin, service } from "@dougongjs/core";
import { expectTypeOf } from "vitest";
import type * as platform from "@dougongjs/platform";

expectTypeOf<platform.RegistrationSnapshot["error"]>().toEqualTypeOf<Error | undefined>();
expectTypeOf<ReturnType<platform.PlatformChangeSet<unknown>["update"]>>().toEqualTypeOf<void>();
expectTypeOf<ReturnType<platform.PlatformChangeSet<unknown>["remove"]>>().toEqualTypeOf<void>();
// @ts-expect-error Artifact carries only the external Reference type.
expectTypeOf<platform.Artifact<string, unknown>>();

type NarrowLoader = {
  load(reference: "known", signal: AbortSignal): unknown;
};
type BroadLoader = {
  load(reference: unknown, signal: AbortSignal): unknown;
};
type NarrowAuthorizer = {
  authorize(manifest: platform.Manifest & { readonly name: "known" }, signal: AbortSignal): void;
};

expectTypeOf<NarrowLoader extends platform.Loader<string> ? true : false>().toEqualTypeOf<false>();
expectTypeOf<BroadLoader extends platform.Loader<string> ? true : false>().toEqualTypeOf<true>();
expectTypeOf<NarrowAuthorizer extends platform.Authorizer ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  platform.MemoryLoader<"known"> extends platform.MemoryLoader<string> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  platform.MemoryLoader<string> extends platform.MemoryLoader<"known"> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  platform.Registration<"known"> extends platform.Registration<string> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  platform.Registration<string> extends platform.Registration<"known"> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  platform.PlatformChangeSet<"known"> extends platform.PlatformChangeSet<string> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  platform.PlatformChangeSet<string> extends platform.PlatformChangeSet<"known"> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  platform.Platform<"known"> extends platform.Platform<string> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  platform.Platform<string> extends platform.Platform<"known"> ? true : false
>().toEqualTypeOf<false>();

const CLOCK = service<() => number>("test/platform-placeholder-clock");
const placeholder = definePlugin({
  name: "typed.placeholder",
  requires: { clock: CLOCK },
  setup(ctx) {
    ctx.clock();
  },
});
const plugins: readonly AnyPlugin[] = [placeholder];
const artifact: platform.Artifact<string> = {
  manifest: { name: "typed.placeholder", version: "1.0.0" },
  reference: "typed-placeholder",
  placeholder: plugins[0]!,
};

expectTypeOf(artifact.placeholder).toEqualTypeOf<AnyPlugin | undefined>();
