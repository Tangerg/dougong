export function assertSynchronous(value: unknown, message: string): void {
  if (!isThenable(value)) return;

  // The synchronous TypeError below is the public outcome of this boundary.
  // Observe the rejected thenable as well so the rejected implementation
  // detail cannot escape later as an unrelated unhandled rejection.
  void Promise.resolve(value).catch(() => undefined);
  throw new TypeError(message);
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}
