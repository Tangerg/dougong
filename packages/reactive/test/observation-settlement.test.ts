import { expect, it, vi } from "vitest";
import {
  observe,
  signal,
  type AsyncDisposable,
  type ObservationOwner,
  type ObservationTask,
} from "../src";

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

it.each([false, true])(
  "releases its subscription and child when its drain task is independently cancelled (before start: %s)",
  async (beforeStart) => {
    const releaseChild = vi.fn<() => void>();
    const unsubscribe = vi.fn<() => void>();
    const base = ownerWithChildren(() => ({
      async [Symbol.asyncDispose]() {
        releaseChild();
      },
    }));
    let runner!: ObservationTask;
    const owner: ObservationOwner = {
      ...base,
      spawn(task) {
        runner = base.spawn(task);
        return runner;
      },
    };
    const source = signal(0);
    const seen: number[] = [];
    const observation = observe(
      owner,
      {
        get: source.get,
        subscribe(listener) {
          const subscription = source.subscribe(listener);
          return {
            [Symbol.dispose]() {
              unsubscribe();
              subscription[Symbol.dispose]();
            },
          };
        },
      },
      (value) => seen.push(value),
    );
    try {
      if (!beforeStart) await nextTurn();
      await runner[Symbol.asyncDispose]();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(releaseChild).toHaveBeenCalledOnce();
      source.set(1);
      await nextTurn();
      expect(seen).toEqual([0]);
    } finally {
      await observation[Symbol.asyncDispose]();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(releaseChild).toHaveBeenCalledOnce();
  },
);

it("shares a failed cancellation cleanup with later observation disposal", async () => {
  const failure = new Error("cancelled child release failed");
  const releaseChild = vi.fn<() => never>(() => {
    throw failure;
  });
  const base = ownerWithChildren(() => ({
    async [Symbol.asyncDispose]() {
      releaseChild();
    },
  }));
  let runner!: ObservationTask;
  const owner: ObservationOwner = {
    ...base,
    spawn(task) {
      runner = base.spawn(task);
      return runner;
    },
  };
  const observation = observe(owner, signal(0), () => undefined);
  await expect(runner[Symbol.asyncDispose]()).rejects.toBe(failure);
  await expect(observation[Symbol.asyncDispose]()).rejects.toBe(failure);
  expect(releaseChild).toHaveBeenCalledOnce();
});

it("releases observation resources when its task owner supplies an invalid signal", async () => {
  const releaseChild = vi.fn<() => void>();
  const unsubscribe = vi.fn<() => void>();
  const base = ownerWithChildren(() => ({
    async [Symbol.asyncDispose]() {
      releaseChild();
    },
  }));
  let completion!: PromiseLike<unknown>;
  const owner: ObservationOwner = {
    ...base,
    spawn(task) {
      const result = Promise.resolve().then(() => task({} as AbortSignal));
      completion = result;
      return {
        result,
        async [Symbol.asyncDispose]() {
          await result;
        },
      };
    },
  };
  const observation = observe(
    owner,
    { get: () => 0, subscribe: () => ({ [Symbol.dispose]: unsubscribe }) },
    () => undefined,
  );
  try {
    await expect(completion).rejects.toBeInstanceOf(TypeError);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(releaseChild).toHaveBeenCalledOnce();
  } finally {
    await observation[Symbol.asyncDispose]();
  }
});

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
