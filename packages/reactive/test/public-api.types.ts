import { expectTypeOf } from "vitest";
import type * as reactive from "@dougongjs/reactive";

type NarrowOwner = {
  readonly defer: reactive.ObservationOwner["defer"];
  child(label: "known"): reactive.AsyncDisposable;
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

type MinimalChild = reactive.AsyncDisposable & { readonly value: string };
expectTypeOf<
  Parameters<reactive.Observer<number, MinimalChild>>[1]
>().toEqualTypeOf<MinimalChild>();
expectTypeOf<
  ReturnType<reactive.ObservationOwner<MinimalChild>["child"]>
>().toEqualTypeOf<MinimalChild>();

expectTypeOf<reactive.ObservationTask["result"]>().toEqualTypeOf<PromiseLike<unknown>>();
expectTypeOf<Parameters<reactive.ObservationOwner["spawn"]>[0]>().toEqualTypeOf<
  (signal: AbortSignal) => void | PromiseLike<void>
>();

interface ResultOwner {
  readonly defer: reactive.ObservationOwner["defer"];
  readonly child: reactive.ObservationOwner["child"];
  readonly spawn: <T>(task: (signal: AbortSignal) => T | PromiseLike<T>) => {
    readonly result: Promise<{ readonly value: T }>;
    [Symbol.asyncDispose](): Promise<void>;
  };
}

expectTypeOf<ResultOwner>().toExtend<reactive.ObservationOwner>();

expectTypeOf<typeof reactive.disposeSymbol>().toEqualTypeOf<typeof Symbol.dispose>();
expectTypeOf<typeof reactive.asyncDisposeSymbol>().toEqualTypeOf<typeof Symbol.asyncDispose>();

// Standard resources need no named disposal alias to cross the protocol boundary.
expectTypeOf<{ [Symbol.dispose](): void }>().toExtend<reactive.Disposable>();
expectTypeOf<{ [Symbol.asyncDispose](): Promise<void> }>().toExtend<reactive.AsyncDisposable>();
expectTypeOf<ReturnType<typeof reactive.bridge<number>>>().toEqualTypeOf<
  reactive.ReadonlySignal<number>
>();
