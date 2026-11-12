import { asyncDisposeSymbol, type LifetimeContext } from "dougong";
import { resolveValue } from "dougong/advanced";
import { abandonOnAbort } from "./abandon-on-abort.js";

type Destination = Pick<LifetimeContext, "signal" | "defer">;
type Operations = Pick<LifetimeContext, "spawn" | "defer">;

export type AcquisitionResult<T> =
  | { readonly status: "acquired"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "retired" };

interface ReleasePayload<T> {
  readonly value: T;
  readonly dispose: (value: T) => unknown;
}

// A failed attempt keeps its payload and completion; only successful release ends ownership.
type ReleaseState<T> =
  | { readonly phase: "ready"; readonly payload: ReleasePayload<T> }
  | {
      readonly phase: "started";
      readonly payload: ReleasePayload<T>;
      readonly completion: Promise<void>;
    }
  | { readonly phase: "released"; readonly completion: Promise<void> };

class ResourceRelease<T> {
  #state: ReleaseState<T>;

  constructor(value: T, dispose: (value: T) => unknown) {
    this.#state = { phase: "ready", payload: { value, dispose } };
  }

  readonly release = (): Promise<void> => {
    const state = this.#state;
    if (state.phase !== "ready") return state.completion;
    const completion = Promise.withResolvers<void>();
    Object.freeze(completion.promise);
    this.#state = {
      phase: "started",
      payload: state.payload,
      completion: completion.promise,
    };
    // A partial target registration may retain this callback while the source also reclaims it.
    void Promise.resolve()
      .then(() => {
        const { value, dispose } = state.payload;
        return resolveValue(dispose(value));
      })
      .then(() => {
        this.#state = { phase: "released", completion: completion.promise };
        completion.resolve();
      }, completion.reject);
    return completion.promise;
  };
}

async function handoff<T>(
  generation: Destination,
  operations: Operations,
  signal: AbortSignal,
  destination: AbortSignal,
  start: () => PromiseLike<T>,
  dispose: (value: Awaited<T>) => unknown,
): Promise<AcquisitionResult<Awaited<T>>> {
  const retired = () =>
    Reflect.get(AbortSignal.prototype, "aborted", signal) === true ||
    Reflect.get(AbortSignal.prototype, "aborted", destination) === true;
  if (retired()) return { status: "retired" };

  // Reserve before starting: shutdown may seal both owners before a non-cooperative factory returns.
  let reclaim: (() => unknown) | undefined;
  const reservation = operations.defer(() => reclaim?.());
  let result: AcquisitionResult<Awaited<T>> = { status: "retired" };
  try {
    if (!retired()) {
      const { value } = await resolveValue(start());
      reclaim = new ResourceRelease(value, dispose).release;
      if (!retired()) {
        generation.defer(reclaim);
        reclaim = undefined;
        result = { status: "acquired", value };
      }
    }
  } catch (error) {
    try {
      await resolveValue(reservation[asyncDisposeSymbol]());
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Resource ownership transfer failed");
    }
    throw error;
  }
  await resolveValue(reservation[asyncDisposeSymbol]());
  return result;
}

export async function acquireForLifetime<T>(
  generation: Destination,
  operations: Operations,
  start: () => PromiseLike<T>,
  dispose: (value: Awaited<T>) => unknown,
): Promise<AcquisitionResult<Awaited<T>>> {
  const destination = generation.signal;
  const { value: outcome } = await abandonOnAbort(destination, () => {
    const operation = operations.spawn((signal) =>
      handoff(generation, operations, signal, destination, start, dispose),
    );

    // The operation Task owns reporting; rethrowing its projected outcome would report the failure twice.
    return resolveValue(operation.result).then(
      ({ value: receipt }) => receipt.value,
      (error: unknown) => ({ status: "failed", error }) as const,
    );
  });
  return outcome;
}
