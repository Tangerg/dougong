// Generated from tooling/internal/synchronous-result.ts. Run pnpm generate:internal.
const nativePromiseThen = Promise.prototype.then;
const promiseProtocolTag = Promise.prototype[Symbol.toStringTag];

export function assertSynchronous(value: unknown, message: string): void {
  const pending = captureThenable(value);
  if (!pending) return;

  // Rejecting a synchronous callback must not leave its captured asynchronous outcome unobserved.
  void pending.then(
    () => undefined,
    () => undefined,
  );
  throw new TypeError(message);
}

export function captureThenable(value: unknown): Promise<unknown> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (hasPromisePrototypeMarker(value)) {
    const result = Promise.withResolvers<unknown>();
    // Intrinsic then validates the native brand across realms; an own then cannot replace its settlement.
    Reflect.apply(nativePromiseThen, value, [
      // These callers only need settlement, and a native fulfilled payload has already been assimilated.
      () => result.resolve(undefined),
      result.reject,
    ]);
    return result.promise;
  }

  // Capture a structural then once and preserve its receiver without running it before the caller unwinds.
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

function hasPromisePrototypeMarker(value: object): boolean {
  const visited = new Set<object>();
  for (
    let prototype: object | null = Object.getPrototypeOf(value);
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (visited.has(prototype)) throw new TypeError("Result has a cyclic prototype chain");
    visited.add(prototype);
    // The marker selects a candidate without executing presentation getters or depending on its realm.
    const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
    if (tag && "value" in tag && tag.value === promiseProtocolTag) return true;
  }
  return false;
}
