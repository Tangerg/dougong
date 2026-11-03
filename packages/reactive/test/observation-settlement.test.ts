import { expect, it, vi } from "vitest";
import { observe, signal, type AsyncDisposable, type ObservationOwner } from "../src";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function ownerWithChildren(child: () => AsyncDisposable): ObservationOwner {
  return {
    defer(dispose) {
      return {
        async [Symbol.asyncDispose]() {
          await dispose();
        },
      };
    },
    child,
    spawn(task) {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => task(controller.signal));
      return {
        result,
        async [Symbol.asyncDispose]() {
          controller.abort();
          await result;
        },
      };
    },
  };
}

it("joins a child's actual native release before creating its replacement", async () => {
  const released = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  // oxlint-disable-next-line unicorn/no-thenable -- Native settlement must remain authoritative after decoration.
  Object.defineProperty(released.promise, "then", { value: undefined });
  let children = 0;
  const owner = ownerWithChildren(() => {
    const initial = children++ === 0;
    return {
      [Symbol.asyncDispose]() {
        if (!initial) return Promise.resolve();
        entered.resolve();
        return released.promise;
      },
    };
  });
  const source = signal(0);
  const seen: number[] = [];
  const observation = observe(owner, source, (value) => seen.push(value));
  try {
    source.set(1);
    await entered.promise;
    await nextTurn();
    expect(children).toBe(1);
    expect(seen).toEqual([0]);
    released.resolve();
    await nextTurn();
    expect(children).toBe(2);
    expect(seen).toEqual([0, 1]);
  } finally {
    released.resolve();
    await observation[Symbol.asyncDispose]();
  }
});

it("joins the registration's native completion after local resources have closed", async () => {
  const registrationTail = Promise.withResolvers<void>();
  const registrationEntered = Promise.withResolvers<void>();
  const registrationClosed = Promise.withResolvers<void>();
  // oxlint-disable-next-line unicorn/no-thenable -- The registration may carry presentation methods without changing its release obligation.
  Object.defineProperty(registrationClosed.promise, "then", { value: undefined });
  const releaseChild = vi.fn<() => void>();
  const base = ownerWithChildren(() => ({
    async [Symbol.asyncDispose]() {
      releaseChild();
    },
  }));
  const owner: ObservationOwner = {
    ...base,
    defer(dispose) {
      let started = false;
      return {
        [Symbol.asyncDispose]() {
          if (!started) {
            started = true;
            void (async () => {
              await dispose();
              registrationEntered.resolve();
              await registrationTail.promise;
            })().then(registrationClosed.resolve, registrationClosed.reject);
          }
          return registrationClosed.promise;
        },
      };
    },
  };
  const observation = observe(owner, signal(0), () => undefined);
  const closing = observation[Symbol.asyncDispose]();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  try {
    await registrationEntered.promise;
    await nextTurn();
    expect(releaseChild).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
  } finally {
    registrationTail.resolve();
    await closing;
  }
  expect(closed).toBe(true);
});

it("joins a native subclass cancellation result before releasing the current child", async () => {
  class Cancellation extends Promise<void> {}
  const cancellationEntered = Promise.withResolvers<void>();
  const cancellationTail = Promise.withResolvers<void>();
  const releaseChild = vi.fn<() => void>();
  const fakeSettlement = vi.fn<(resolve: () => void) => void>((resolve) => resolve());
  const base = ownerWithChildren(() => ({
    async [Symbol.asyncDispose]() {
      releaseChild();
    },
  }));
  const owner: ObservationOwner = {
    ...base,
    spawn(task) {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => task(controller.signal));
      const cancellation = new Cancellation((resolve, reject) => {
        void result.then(() => cancellationTail.promise).then(resolve, reject);
      });
      // oxlint-disable-next-line unicorn/no-thenable -- Await would otherwise assimilate this subclass through the shadow method.
      Object.defineProperty(cancellation, "then", { value: fakeSettlement });
      return {
        result,
        [Symbol.asyncDispose]() {
          controller.abort();
          cancellationEntered.resolve();
          return cancellation;
        },
      };
    },
  };
  const observation = observe(owner, signal(0), () => undefined);
  const closing = observation[Symbol.asyncDispose]();
  try {
    await cancellationEntered.promise;
    await nextTurn();
    expect(fakeSettlement).not.toHaveBeenCalled();
    expect(releaseChild).not.toHaveBeenCalled();
  } finally {
    cancellationTail.resolve();
    await closing;
  }
  expect(releaseChild).toHaveBeenCalledOnce();
});
