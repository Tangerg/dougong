import type { ResolvedValue } from "dougong";
import { onAbort, resolveValue } from "dougong/advanced";

// Only abandon operations whose late values and failures are safe to ignore.
export function abandonOnAbort<T>(
  signal: AbortSignal,
  start: () => PromiseLike<T>,
): Promise<ResolvedValue<Awaited<T>>> {
  return new Promise<ResolvedValue<Awaited<T>>>((resolve, reject) => {
    const detach = onAbort(signal, reject);

    void Promise.resolve()
      .then(() => {
        // A separate start reaction would allow abort to arrive after the check.
        AbortSignal.prototype.throwIfAborted.call(signal);
        return resolveValue(start());
      })
      .then(
        (value) => {
          detach();
          resolve(value);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
  });
}
