// Generated from tooling/internal/async-result.ts. Run pnpm generate:internal.
const localPromisePrototype = Promise.prototype;
const nativePromiseThen = localPromisePrototype.then;

export interface ResolvedValue<T> {
  readonly value: T;
}

export async function resolveValue<T>(
  value: T | PromiseLike<T>,
): Promise<ResolvedValue<Awaited<T>>> {
  return (captureThenable(value) ?? Object.freeze({ value })) as
    ResolvedValue<Awaited<T>> | Promise<ResolvedValue<Awaited<T>>>;
}

export function assertSynchronous(value: unknown, message: string): void {
  const pending = captureThenable(value);
  if (!pending) return;

  // Rejecting a synchronous callback must not leave its asynchronous outcome unobserved.
  void pending.then(
    () => undefined,
    () => undefined,
  );
  throw new TypeError(message);
}

export function captureThenable(value: unknown): Promise<ResolvedValue<unknown>> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (hasLocalPromisePrototype(value)) {
    const result = Promise.withResolvers<ResolvedValue<unknown>>();
    // This prototype selects the local native protocol; intrinsic then validates its brand.
    // A constructor or species failure is final, never a reason to try another protocol.
    Reflect.apply(nativePromiseThen, value, [
      // Native fulfillment is already data; resolving with it again could change its meaning.
      (resolved: unknown) => result.resolve(Object.freeze({ value: resolved })),
      result.reject,
    ]);
    return result.promise;
  }

  // Foreign and structural promises use one captured public then, including its receiver.
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
  return result.promise.then((resolved) => Object.freeze({ value: resolved }));
}

function hasLocalPromisePrototype(value: object): boolean {
  const visited = new Set<object>();
  for (
    let prototype: object | null = Object.getPrototypeOf(value);
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (prototype === localPromisePrototype) return true;
    if (visited.has(prototype)) throw new TypeError("Result has a cyclic prototype chain");
    visited.add(prototype);
  }
  return false;
}
