// The boundary that keeps a synchronous contract honest.
//
// Several protocols in Dougong require synchronous callbacks — snapshot
// subscribers, loggers, `group()` configure. Each has the same reason: the
// callback observes or contributes to state that has already moved on by the
// time an async continuation would resume, so returning a promise is not slower,
// it is wrong.
//
export function assertSynchronous(value: unknown, message: string): void {
  const pending = captureThenable(value);
  if (!pending) return;

  // The synchronous TypeError below is the public outcome of this boundary.
  // Observe the rejected thenable as well so the rejected implementation
  // detail cannot escape later as an unrelated unhandled rejection.
  void pending.catch(() => undefined);
  throw new TypeError(message);
}

// Capture the protocol once, including custom and foreign-realm thenables.
// Invoke in a Promise job with the original receiver; assimilation must not
// reread a getter that can select another asynchronous outcome.
export function captureThenable(value: unknown): Promise<unknown> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const then = (value as { readonly then?: unknown }).then;
  if (typeof then !== "function") return;
  return Promise.resolve().then(
    () => new Promise<unknown>((resolve, reject) => Reflect.apply(then, value, [resolve, reject])),
  );
}
