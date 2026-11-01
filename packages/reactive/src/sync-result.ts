// Generated from tooling/internal/sync-result.ts. Run pnpm generate:internal.
export function assertSynchronous(value: unknown, message: string): void {
  const pending = captureThenable(value);
  if (!pending) return;

  // Observe thenable rejection as well as throwing synchronously so invalid callbacks cannot create unhandled failures.
  void pending.then(
    () => undefined,
    () => undefined,
  );
  throw new TypeError(message);
}

// Capture then once and preserve its receiver so assimilation cannot repeat an effectful getter.
export function captureThenable(value: unknown): Promise<unknown> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const then = (value as { readonly then?: unknown }).then;
  if (typeof then !== "function") return;
  const result = Promise.withResolvers<unknown>();
  queueMicrotask(() => {
    try {
      Reflect.apply(then, value, [result.resolve, result.reject]);
    } catch (error) {
      result.reject(error);
    }
  });
  return result.promise;
}
