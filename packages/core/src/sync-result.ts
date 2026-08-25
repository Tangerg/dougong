// The boundary that keeps a synchronous contract honest.
//
// Several protocols in Dougong require synchronous callbacks — snapshot
// subscribers, loggers, `group()` configure. Each has the same reason: the
// callback observes or contributes to state that has already moved on by the
// time an async continuation would resume, so returning a promise is not slower,
// it is wrong.
//
// This file is duplicated verbatim in @dougongjs/core and @dougongjs/reactive.
// The two packages are independent foundations — neither may import the other —
// and `check-layers.mjs` asserts the copies stay byte-identical, so an edit here
// must be applied to both.

export function assertSynchronous(value: unknown, message: string): void {
  if (!isThenable(value)) return;

  // The synchronous TypeError below is the public outcome of this boundary.
  // Observe the rejected thenable as well so the rejected implementation
  // detail cannot escape later as an unrelated unhandled rejection.
  void Promise.resolve(value).catch(() => undefined);
  throw new TypeError(message);
}

// Duck-typed rather than `instanceof Promise`: a thenable from another realm, or
// any custom implementation, still has to be caught here.
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}
