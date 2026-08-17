import { expectTypeOf } from "vitest";
import type * as reactive from "@dougongjs/reactive";

type NarrowOwner = {
  readonly cleanup: reactive.ObservationOwner["cleanup"];
  lifetime(label: "known"): reactive.ObservationLifetime;
  readonly spawn: reactive.ObservationOwner["spawn"];
};
expectTypeOf<NarrowOwner extends reactive.ObservationOwner ? true : false>().toEqualTypeOf<false>();

interface Entity {
  readonly id: string;
}

interface User extends Entity {
  readonly email: string;
}

expectTypeOf<
  reactive.Signal<User> extends reactive.Signal<Entity> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  reactive.Signal<Entity> extends reactive.Signal<User> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  reactive.ReadonlySignal<User> extends reactive.ReadonlySignal<Entity> ? true : false
>().toEqualTypeOf<true>();
expectTypeOf<
  reactive.ReadonlySignal<Entity> extends reactive.ReadonlySignal<User> ? true : false
>().toEqualTypeOf<false>();
