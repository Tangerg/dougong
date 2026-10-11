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
        // An external AbortError is not cancellation requested by this Task.
        throw new Error("External resource operation failed", { cause });
      }
    });

    // The operation Task owns reporting; rethrowing its projected outcome would report the failure twice.
    return operation.result.then(
      (result) => result,
      (error: unknown) => ({ status: "failed", error }) as const,
    );
  });
}
