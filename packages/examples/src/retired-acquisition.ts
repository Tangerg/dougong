import type { LifetimeContext } from "dougong";
import { abandonOnAbort } from "./abandon-on-abort";

export type AcquisitionResult<T> =
  | { readonly status: "acquired"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "retired" };

export function acquireForLifetime<T>(
  generation: LifetimeContext,
  operations: LifetimeContext,
  start: () => PromiseLike<T>,
  dispose: (value: T) => unknown,
): Promise<AcquisitionResult<T>> {
  return abandonOnAbort(generation.signal, () => {
    const operation = operations.spawn(async (signal) => {
      if (signal.aborted || generation.signal.aborted) return { status: "retired" } as const;

      try {
        const value = await start();
        if (generation.signal.aborted) {
          await dispose(value);
          return { status: "retired" } as const;
        }

        try {
          generation.cleanup(() => dispose(value));
        } catch (error) {
          try {
            await dispose(value);
          } catch (disposalError) {
            throw new AggregateError([error, disposalError], "Resource ownership transfer failed");
          }
          throw error;
        }
        return { status: "acquired", value } as const;
      } catch (cause) {
        // External failures are not cancellation of this Task, even when an
        // adapter names its error AbortError and the operations Lifetime stops.
        throw new Error("External resource operation failed", { cause });
      }
    });

    // The operation Task owns reporting; the waiting generation only projects
    // its outcome. Re-throwing here would report the same failure a second time.
    return operation.result.then(
      (result) => result,
      (error: unknown) => ({ status: "failed", error }) as const,
    );
  });
}
