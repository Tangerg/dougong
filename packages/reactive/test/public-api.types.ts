import { expectTypeOf } from "vitest";
import type * as reactive from "@dougongjs/reactive";
import { batch, computed, observe, signal } from "@dougongjs/reactive";

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

function synchronousComposition<T>(callback: Parameters<typeof batch<T>>[0]) {
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

const count = signal(1);
declare const observationOwner: reactive.ObservationOwner<MinimalChild>;

expectTypeOf(count.subscribe(() => count.get())).toEqualTypeOf<reactive.Disposable>();
expectTypeOf(count.subscribe(() => {})).toEqualTypeOf<reactive.Disposable>();
expectTypeOf(observe(observationOwner, count, () => {})).toEqualTypeOf<reactive.AsyncDisposable>();
expectTypeOf(
  observe(observationOwner, count, (value, child) => value + child.value.length),
).toEqualTypeOf<reactive.AsyncDisposable>();

const noResultObserver: reactive.Observer<number, MinimalChild> = () => {};
expectTypeOf(
  observe(observationOwner, count, noResultObserver),
).toEqualTypeOf<reactive.AsyncDisposable>();
declare const typedVoidObserver: (value: number, child: MinimalChild) => void;
expectTypeOf(
  observe<number, MinimalChild>(observationOwner, count, typedVoidObserver),
).toEqualTypeOf<reactive.AsyncDisposable>();
const numericObserver: reactive.Observer<number, MinimalChild, number> = (value) => value;
expectTypeOf(
  observe(observationOwner, count, numericObserver),
).toEqualTypeOf<reactive.AsyncDisposable>();

// @ts-expect-error Subscriptions cannot join an async callback's continuation.
count.subscribe(async () => {});
// @ts-expect-error Computed subscriptions have the same synchronous notification boundary.
computed(() => count.get()).subscribe(() => pending);
// @ts-expect-error Every possible subscription result must be synchronous.
count.subscribe(mixedResult);
// @ts-expect-error Observers register ownership synchronously; async work belongs to the child.
observe(observationOwner, count, async () => {});
// @ts-expect-error Structural Promise results cannot escape the synchronous observer boundary.
observe(observationOwner, count, structuralResult);
// @ts-expect-error An explicitly declared observer cannot return an async result either.
const asynchronousObserver: reactive.Observer<number, MinimalChild> = async () => {};
void asynchronousObserver;
// @ts-expect-error Explicit void cannot discard an asynchronous batch result.
batch<void>(async () => {});
// @ts-expect-error Explicit void cannot discard an asynchronous computed result.
computed<void>(async () => {});
// @ts-expect-error Explicit void cannot discard an asynchronous subscriber result.
count.subscribe<void>(async () => {});
// @ts-expect-error A default observer result is still a synchronous contract.
observe<number, MinimalChild>(observationOwner, count, async () => {});
// @ts-expect-error A composed boundary derives the same contract rather than weakening it to void.
synchronousComposition<void>(async () => {});

type CompletingThen = (fulfill: (value: number) => void) => void;
declare const completing: { readonly then: CompletingThen };
declare const optionalThen: { readonly then?: CompletingThen };
declare const mixedThen: { readonly then: string | CompletingThen };
declare const optionalMixedThen: { readonly then?: string | CompletingThen };
declare const indexedThen: Readonly<Record<string, CompletingThen>>;
declare const mixedThenableResult: () => number | typeof completing;
declare const textThenData: { then: "ready" };
declare const undefinedThenData: { then: undefined };
declare const ordinaryThenData: { readonly then?: string };
declare const indexedData: Readonly<Record<string, string>>;
declare const synchronousVoid: () => void;
declare const synchronousUnion: () => number | "unavailable";
declare const optionalSynchronousValue: () => number | undefined;

expectTypeOf(batch(() => textThenData)).toEqualTypeOf<{ then: "ready" }>();
expectTypeOf(computed(() => undefinedThenData)).toEqualTypeOf<
  reactive.ReadonlySignal<{ then: undefined }>
>();
expectTypeOf(batch(() => ordinaryThenData)).toEqualTypeOf<typeof ordinaryThenData>();
expectTypeOf(batch(() => indexedData)).toEqualTypeOf<typeof indexedData>();
expectTypeOf(computed(() => ordinaryThenData)).toEqualTypeOf<
  reactive.ReadonlySignal<typeof ordinaryThenData>
>();
expectTypeOf(batch(() => ({ pending: completing }))).toEqualTypeOf<{
  pending: typeof completing;
}>();
expectTypeOf(batch(synchronousVoid)).toEqualTypeOf<void>();
expectTypeOf(computed(synchronousVoid)).toEqualTypeOf<reactive.ReadonlySignal<void>>();
expectTypeOf(batch(synchronousUnion)).toEqualTypeOf<number | "unavailable">();
expectTypeOf(computed(synchronousUnion)).toEqualTypeOf<
  reactive.ReadonlySignal<number | "unavailable">
>();
expectTypeOf(batch(optionalSynchronousValue)).toEqualTypeOf<number | undefined>();
expectTypeOf(computed(optionalSynchronousValue)).toEqualTypeOf<
  reactive.ReadonlySignal<number | undefined>
>();
count.subscribe(() => ordinaryThenData);
observe(observationOwner, count, () => ordinaryThenData);

// @ts-expect-error A callable then is asynchronous even when it does not return PromiseLike.
batch(() => completing);
// @ts-expect-error Computed collection cannot continue through a nonstandard thenable.
computed(() => completing);
// @ts-expect-error Subscribers cannot join a nonstandard thenable continuation.
count.subscribe(() => completing);
// @ts-expect-error Observer ownership must be registered before a thenable continuation.
observe(observationOwner, count, () => completing);
// @ts-expect-error An optional callable then still makes the callback potentially asynchronous.
batch(() => optionalThen);
// @ts-expect-error An optional callable then cannot extend dependency collection.
computed(() => optionalThen);
// @ts-expect-error An optional callable then cannot extend a notification.
count.subscribe(() => optionalThen);
// @ts-expect-error An optional callable then cannot extend ownership registration.
observe(observationOwner, count, () => optionalThen);
// @ts-expect-error The then property's callable branch remains asynchronous.
batch(() => mixedThen);
// @ts-expect-error A non-callable branch cannot hide the then property's callable branch.
computed(() => mixedThen);
// @ts-expect-error A callable then branch cannot extend a notification.
count.subscribe(() => mixedThen);
// @ts-expect-error A callable then branch cannot extend ownership registration.
observe(observationOwner, count, () => mixedThen);
// @ts-expect-error Optionality does not remove the then property's callable branch.
batch(() => optionalMixedThen);
// @ts-expect-error Optionality does not authorize asynchronous computed results.
computed(() => optionalMixedThen);
// @ts-expect-error A string index signature can declare a callable then property too.
batch(() => indexedThen);
// @ts-expect-error An indexed callable then cannot extend dependency collection.
computed(() => indexedThen);
// @ts-expect-error An indexed callable then cannot extend a notification.
count.subscribe(() => indexedThen);
// @ts-expect-error An indexed callable then cannot extend ownership registration.
observe(observationOwner, count, () => indexedThen);
// @ts-expect-error Every possible result must remain within the synchronous boundary.
batch(mixedThenableResult);
// @ts-expect-error Every computed result branch must finish before collection ends.
computed(mixedThenableResult);
// @ts-expect-error Every subscriber result branch must finish within the notification.
count.subscribe(mixedThenableResult);
// @ts-expect-error Every observer result branch must register ownership synchronously.
observe(observationOwner, count, mixedThenableResult);
