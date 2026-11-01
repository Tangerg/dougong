import { describe, expect, it, vi } from "vitest";
import {
  bridge,
  computed,
  signal,
  type AsyncDisposable,
  type BridgeOwner,
  type Readable,
} from "../src";

class Owner implements BridgeOwner, AsyncDisposable {
  readonly #releases: Array<() => unknown> = [];

  defer(release: () => unknown): AsyncDisposable {
    this.#releases.push(release);
    return {
      [Symbol.asyncDispose]: async () => {
        await release();
      },
    };
  }

  async [Symbol.asyncDispose]() {
    for (const release of this.#releases.splice(0).reverse()) await release();
  }
}

describe("Readable bridge", () => {
  it("tracks a signal created by an independently loaded reactive copy", async () => {
    vi.resetModules();
    const foreign = await import("../src/signals");
    const source = foreign.signal(1);
    const owner = new Owner();
    const local = bridge(owner, source);
    const derived = computed(() => local.get() * 2);
    expect(derived.get()).toBe(2);
    source.set(2);
    expect(derived.get()).toBe(4);
    await owner[Symbol.asyncDispose]();
    expect(() => local.get()).toThrow("disposed");
    expect(() => derived.get()).toThrow("disposed");
  });

  it("owns one standard subscription, releases once and rejects terminal access", async () => {
    const signalSource = signal({ id: "a" });
    const disposed = vi.fn<() => void>();
    const source: Readable<{ id: string }> = {
      get: signalSource.get,
      subscribe(listener) {
        const inner = signalSource.subscribe(listener);
        return {
          [Symbol.dispose]() {
            disposed();
            inner[Symbol.dispose]();
          },
        };
      },
    };
    const owner = new Owner();
    const local = bridge(owner, source);
    expect(local.get()).toBe(signalSource.get());
    expect("set" in local).toBe(false);
    const changed = vi.fn<() => void>();
    const subscription = local.subscribe(changed);
    expect(changed).not.toHaveBeenCalled();
    signalSource.set({ id: "b" });
    expect(changed).toHaveBeenCalledOnce();
    subscription[Symbol.dispose]();
    subscription[Symbol.dispose]();
    await owner[Symbol.asyncDispose]();
    await owner[Symbol.asyncDispose]();
    signalSource.set({ id: "c" });
    expect(changed).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    expect(() => local.subscribe(() => undefined)).toThrow("disposed");
  });

  it("captures a value changed while subscribe attaches without replaying to callers", async () => {
    let value = 1;
    const owner = new Owner();
    const local = bridge(owner, {
      get: () => value,
      subscribe() {
        value = 2;
        return { [Symbol.dispose]() {} };
      },
    });
    const changed = vi.fn<() => void>();
    local.subscribe(changed);
    expect(local.get()).toBe(2);
    expect(changed).not.toHaveBeenCalled();
    await owner[Symbol.asyncDispose]();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("does not notify for equal source values", async () => {
    let notify!: () => void;
    const owner = new Owner();
    const local = bridge(owner, {
      get: () => 1,
      subscribe(listener) {
        notify = listener;
        return { [Symbol.dispose]() {} };
      },
    });
    const changed = vi.fn<() => void>();
    local.subscribe(changed);
    notify();
    expect(changed).not.toHaveBeenCalled();
    await owner[Symbol.asyncDispose]();
  });

  it("releases a subscription returned after reentrant owner disposal", () => {
    let release!: () => unknown;
    const owner = {
      defer(fn: () => unknown) {
        release = fn;
        return { async [Symbol.asyncDispose]() {} };
      },
    };
    const disposed = vi.fn<() => void>();
    expect(() =>
      bridge(owner, {
        get: () => 1,
        subscribe() {
          release();
          return { [Symbol.dispose]: disposed };
        },
      }),
    ).toThrow("disposed");
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("reports disposal failures while clearing the value and observers", async () => {
    const owner = new Owner();
    const failure = new Error("cannot unsubscribe");
    const local = bridge(owner, {
      get: () => "value",
      subscribe: () => ({
        [Symbol.dispose]() {
          throw failure;
        },
      }),
    });
    await expect(owner[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(() => local.get()).toThrow("disposed");
  });

  it("aggregates notification and subscription disposal errors", async () => {
    const owner = new Owner();
    const local = bridge(owner, {
      get: () => "value",
      subscribe: () => ({
        [Symbol.dispose]() {
          throw new Error("release");
        },
      }),
    });
    local.subscribe(() => {
      throw new Error("observer");
    });
    await expect(owner[Symbol.asyncDispose]()).rejects.toThrow(AggregateError);
  });

  it("cleans a subscription when the post-attachment read fails", () => {
    let reads = 0;
    const disposed = vi.fn<() => void>();
    expect(() =>
      bridge(new Owner(), {
        get() {
          if (++reads > 1) throw new Error("read failed");
          return 1;
        },
        subscribe: () => ({ [Symbol.dispose]: disposed }),
      }),
    ).toThrow("read failed");
    expect(disposed).toHaveBeenCalledOnce();
  });
  it("validates owner and readable protocols before subscribing", () => {
    expect(() => bridge(undefined as never, signal(0))).toThrow("resource owner");
    expect(() => bridge(new Owner(), undefined as never)).toThrow("readable source");
    expect(() => bridge(new Owner(), { get: () => 0 } as never)).toThrow("readable source");
    expect(() => bridge({ defer: () => ({}) } as never, signal(0))).toThrow("AsyncDisposable");
    expect(() => bridge(new Owner(), { get: () => 0, subscribe: () => ({}) } as never)).toThrow(
      "Disposable",
    );
  });

  it("captures protocol methods once without losing their receiver", async () => {
    const owner = new Owner();
    const source = {
      value: 3,
      get get() {
        getReads++;
        return function (this: { value: number }) {
          return this.value;
        };
      },
      get subscribe() {
        subscribeReads++;
        return function (this: { value: number }) {
          expect(this.value).toBe(3);
          return { [Symbol.dispose]() {} };
        };
      },
    };
    let getReads = 0;
    let subscribeReads = 0;
    const local = bridge(owner, source);
    expect(local.get()).toBe(3);
    expect([getReads, subscribeReads]).toEqual([1, 1]);
    await owner[Symbol.asyncDispose]();
  });

  it("does not subscribe after an owner closes during registration", () => {
    const subscribe = vi.fn<Readable<number>["subscribe"]>();
    expect(() =>
      bridge(
        {
          defer(release) {
            release();
            return { async [Symbol.asyncDispose]() {} };
          },
        },
        { get: () => 0, subscribe },
      ),
    ).toThrow("disposed");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("ignores late source notifications after revocation", async () => {
    const owner = new Owner();
    let notify!: () => void;
    let reads = 0;
    bridge(owner, {
      get() {
        reads++;
        return 1;
      },
      subscribe(listener) {
        notify = listener;
        return { [Symbol.dispose]() {} };
      },
    });
    await owner[Symbol.asyncDispose]();
    const before = reads;
    notify();
    expect(reads).toBe(before);
  });

  it("preserves both attachment and cleanup failures", async () => {
    const owner = new Owner();
    const readFailure = new Error("read");
    const releaseFailure = new Error("release");
    let reads = 0;
    expect(() =>
      bridge(owner, {
        get() {
          if (++reads === 2) throw readFailure;
          return 1;
        },
        subscribe: () => ({
          [Symbol.dispose]() {
            throw releaseFailure;
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ errors: [readFailure, releaseFailure] }));
    await expect(owner[Symbol.asyncDispose]()).rejects.toBe(releaseFailure);
  });

  it("rejects asynchronous unsubscribe without losing its rejection", async () => {
    const owner = new Owner();
    bridge(owner, {
      get: () => 1,
      subscribe: () => ({
        [Symbol.dispose]() {
          return Promise.reject(new Error("late unsubscribe"));
        },
      }),
    });
    await expect(owner[Symbol.asyncDispose]()).rejects.toThrow("must dispose synchronously");
    await Promise.resolve();
  });
});

it("cannot revive the last bridge value if a foreign read revokes its owner", () => {
  let close!: () => unknown;
  let notify!: () => void;
  let revoking = false;
  const released = vi.fn<() => void>();
  const local = bridge(
    {
      defer(callback) {
        close = callback;
        return {
          async [Symbol.asyncDispose]() {
            await callback();
          },
        };
      },
    },
    {
      get() {
        if (revoking) close();
        return 5;
      },
      subscribe(listener) {
        notify = listener;
        return { [Symbol.dispose]: released };
      },
    },
  );
  revoking = true;
  notify();
  expect(() => local.get()).toThrow("disposed");
  expect(released).toHaveBeenCalledOnce();
});

it("keeps a failed late subscription release in the owner completion during reentrant attachment", async () => {
  const error = new Error("late unsubscribe failed");
  let stop!: () => unknown;
  let finishing!: Promise<unknown>;
  const release = vi.fn<() => never>(() => {
    throw error;
  });
  const owner: BridgeOwner = {
    defer(callback) {
      stop = callback;
      return {
        async [Symbol.asyncDispose]() {
          await callback();
        },
      };
    },
  };
  expect(() =>
    bridge(owner, {
      get: () => 1,
      subscribe() {
        finishing = Promise.resolve(stop());
        return { [Symbol.dispose]: release };
      },
    }),
  ).toThrow(AggregateError);
  await expect(finishing).rejects.toBe(error);
  expect(release).toHaveBeenCalledOnce();
});

it("refuses to return an already revoked bridge when the post-attachment read closes its owner", async () => {
  let revoke!: () => unknown;
  let closing!: Promise<unknown>;
  let attached = false;
  const released = vi.fn<() => void>();
  const owner: BridgeOwner = {
    defer(callback) {
      revoke = callback;
      return {
        async [Symbol.asyncDispose]() {
          await callback();
        },
      };
    },
  };
  expect(() =>
    bridge(owner, {
      get() {
        if (attached) closing = Promise.resolve(revoke());
        return 1;
      },
      subscribe() {
        attached = true;
        return { [Symbol.dispose]: released };
      },
    }),
  ).toThrow("Readable bridge has been disposed");
  await closing;
  expect(released).toHaveBeenCalledOnce();
});

it.each([0, 2])(
  "does not let a superseded foreign read overwrite a nested value of %s",
  async (latest) => {
    const owner = new Owner();
    let value = 0;
    let notify!: () => void;
    let nested = false;
    const local = bridge(owner, {
      get() {
        const captured = value;
        if (nested) {
          nested = false;
          value = latest;
          notify();
        }
        return captured;
      },
      subscribe(listener) {
        notify = listener;
        return { [Symbol.dispose]() {} };
      },
    });
    const observed: number[] = [];
    const subscription = local.subscribe(() => observed.push(local.get()));
    value = 1;
    nested = true;
    notify();
    expect(local.get()).toBe(latest);
    expect(observed).toEqual(latest === 0 ? [] : [2]);
    subscription[Symbol.dispose]();
    await owner[Symbol.asyncDispose]();
  },
);

it("projects a source read failure and notifies recovery even when the recovered value is unchanged", async () => {
  const revision = signal(0);
  const failure = new Error("unavailable");
  const source = computed(() => {
    if (revision.get() === 1) throw failure;
    return "ready";
  });
  const owner = new Owner();
  const local = bridge(owner, source);
  const rendered = computed(() => {
    try {
      return local.get();
    } catch (error) {
      return error;
    }
  });
  const seen: unknown[] = [];
  using subscription = rendered.subscribe(() => {
    seen.push(rendered.get());
  });
  revision.set(1);
  expect(() => local.get()).toThrow(failure);
  revision.set(2);
  expect(seen).toEqual([failure, "ready"]);
  subscription[Symbol.dispose]();
  await owner[Symbol.asyncDispose]();
});
