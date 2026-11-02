import { asyncDisposeSymbol, type LifetimeContext } from "dougong";
import { abandonOnAbort } from "./abandon-on-abort.js";

type Destination = Pick<LifetimeContext, "signal" | "defer">;
type Operations = Pick<LifetimeContext, "spawn" | "defer">;

export type AcquisitionResult<T> =
  | { readonly status: "acquired"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "retired" };

async function handoff<T>(
  generation: Destination,
  operations: Operations,
  signal: AbortSignal,
  destination: AbortSignal,
  start: () => PromiseLike<T>,
  dispose: (value: T) => unknown,
): Promise<AcquisitionResult<T>> {
  const retired = () =>
    Reflect.get(AbortSignal.prototype, "aborted", signal) === true ||
    Reflect.get(AbortSignal.prototype, "aborted", destination) === true;
  if (retired()) return { status: "retired" };

  // Reserve before starting: shutdown may seal both owners before a non-cooperative factory returns.
  let reclaim: (() => unknown) | undefined;
  const reservation = operations.defer(() => reclaim?.());
  let result: AcquisitionResult<T> = { status: "retired" };
  try {
    if (!retired()) {
      const value = await start();
      reclaim = () => dispose(value);
      if (!retired()) {
        generation.defer(reclaim);
        reclaim = undefined;
        result = { status: "acquired", value };
      }
    }
  } catch (error) {
    try {
      await reservation[asyncDisposeSymbol]();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Resource ownership transfer failed");
    }
    throw error;
  }
  await reservation[asyncDisposeSymbol]();
  return result;
}

export function acquireForLifetime<T>(
  generation: Destination,
  operations: Operations,
  start: () => PromiseLike<T>,
  dispose: (value: T) => unknown,
): Promise<AcquisitionResult<T>> {
  const destination = generation.signal;
  return abandonOnAbort(destination, () => {
    const operation = operations.spawn((signal) =>
      handoff(generation, operations, signal, destination, start, dispose),
    );

    // The operation Task owns reporting; rethrowing its projected outcome would report the failure twice.
    return operation.result.then(
      (result) => result,
      (error: unknown) => ({ status: "failed", error }) as const,
    );
  });
}
