import { expectTypeOf } from "vitest";
import type * as reactive from "@dougongjs/reactive";
import { batch, computed, signal } from "@dougongjs/reactive";

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

expectTypeOf(batch(() => 7 as const)).toEqualTypeOf<7>();
expectTypeOf(batch(() => {})).toEqualTypeOf<void>();
expectTypeOf(computed(() => "ready" as const)).toEqualTypeOf<reactive.ReadonlySignal<"ready">>();

const pending = Promise.resolve(1);
expectTypeOf(signal(pending)).toEqualTypeOf<reactive.Signal<Promise<number>>>();
expectTypeOf(batch(() => ({ pending }))).toEqualTypeOf<{ pending: Promise<number> }>();
expectTypeOf(computed(() => ({ pending }))).toEqualTypeOf<
  reactive.ReadonlySignal<{ pending: Promise<number> }>
>();
expectTypeOf(batch((): unknown => "checked at runtime")).toEqualTypeOf<unknown>();
expectTypeOf(computed((): unknown => "checked at runtime")).toEqualTypeOf<
  reactive.ReadonlySignal<unknown>
>();

function synchronousComposition<T>(callback: () => T & Exclude<T, PromiseLike<unknown>>) {
  const value: T = batch<T>(callback);
  const derived: reactive.ReadonlySignal<T> = computed<T>(callback);
  return { value, derived };
}
expectTypeOf(synchronousComposition(() => 1)).toEqualTypeOf<{
  value: number;
  derived: reactive.ReadonlySignal<number>;
}>();

// @ts-expect-error An async callback cannot keep its continuation inside a synchronous batch.
batch(async () => 1);
// @ts-expect-error Computed tracking ends before an async calculation can resume.
computed(async () => 1);
// @ts-expect-error A normal function returning a Promise is asynchronous too.
batch(() => pending);
// @ts-expect-error A direct Promise is not a supported computed result.
computed(() => pending);

declare const structuralResult: () => PromiseLike<number>;
// @ts-expect-error The synchronous boundary also excludes structural Promise results.
batch(structuralResult);
// @ts-expect-error The synchronous boundary also excludes structural Promise results.
computed(structuralResult);

declare const mixedResult: () => number | Promise<number>;
// @ts-expect-error Every possible result must satisfy the synchronous boundary.
batch(mixedResult);
// @ts-expect-error Every possible result must satisfy the synchronous boundary.
computed(mixedResult);
