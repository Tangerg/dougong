import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/advanced";

describe("SerialQueue", () => {
  it("accepts synchronous operations but refuses ambiguous input", async () => {
    const queue = new SerialQueue();

    expect(() => queue.run(undefined as never)).toThrowError(
      new TypeError("SerialQueue operation must be a function"),
    );
    expect(() => queue.run(() => 1, null as never)).toThrow(TypeError);
    await expect(queue.run(() => 1)).resolves.toEqual({ value: 1 });
  });

  it("isolates caller results while continuing after a failed operation", async () => {
    const queue = new SerialQueue();
    const trace: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("first failed");

    const first = queue.run(async () => {
      trace.push("first:start");
      await blocked;
      trace.push("first:end");
      throw failure;
    });
    const firstSettled = queue.settled();
    const second = queue.run(async () => {
      trace.push("second");
      return 2;
    });
    const settled = queue.settled();

    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);
    release();

    await expect(first).rejects.toBe(failure);
    await expect(firstSettled).resolves.toBeUndefined();
    await expect(second).resolves.toEqual({ value: 2 });
    await expect(settled).resolves.toBeUndefined();
    expect(trace).toEqual(["first:start", "first:end", "second"]);
  });
  it("does not give the settlement observer control of subsequent commands", async () => {
    const queue = new SerialQueue();
    const blocked = Promise.withResolvers<void>();
    const trace: string[] = [];
    const first = queue.run(async () => {
      await blocked.promise;
      trace.push("first");
    });
    const observed = queue.settled();
    Object.defineProperty(observed, "constructor", {
      get() {
        throw new Error("caller-owned observer");
      },
    });
    try {
      const second = queue.run(() => trace.push("second"));
      blocked.resolve();
      await second;
      expect(trace).toEqual(["first", "second"]);
    } finally {
      blocked.resolve();
      await first;
    }
  });

  it("waits for a decorated native Promise before starting the next command", async () => {
    const queue = new SerialQueue();
    const pending = Promise.withResolvers<void>();
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand.
    Object.defineProperty(pending.promise, "then", { value: undefined });
    const trace: string[] = [];
    const first = queue.run(() => {
      trace.push("first");
      return pending.promise;
    });
    const second = queue.run(() => {
      trace.push("second");
      return 2;
    });
    let settled = false;
    void queue.settled().then(() => {
      settled = true;
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(trace).toEqual(["first"]);
      expect(settled).toBe(false);
    } finally {
      pending.resolve();
      await Promise.all([first, second]);
    }
    expect(trace).toEqual(["first", "second"]);
    expect((await second).value).toBe(2);
  });

  it("preserves an already fulfilled native Promise payload without resolving it again", async () => {
    const queue = new SerialQueue();
    let reads = 0;
    const payload = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (key === "then" && ++reads > 1)
            throw new Error("queued payload was assimilated again");
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const fulfilled = Promise.resolve(payload);
    expect(reads).toBe(1);

    const receipt = await queue.run(() => fulfilled);
    expect(receipt.value).toBe(payload);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(reads).toBe(1);
  });
});

it("cancels only queued work and retains the position of later commands", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number>();
  const first = queue.run(() => {
    entered.resolve();
    return release.promise;
  }, controller.signal);
  await entered.promise;
  let called = false;
  const cancelled = queue.run(() => {
    called = true;
  }, controller.signal);
  const trace: string[] = [];
  const last = queue.run(() => trace.push("last"));
  controller.abort("retired");
  try {
    await expect(cancelled).rejects.toBe("retired");
    await expect(
      queue.run(() => {
        called = true;
      }, controller.signal),
    ).rejects.toBe("retired");
    expect(called).toBe(false);
    expect(trace).toEqual([]);
  } finally {
    release.resolve(7);
    expect((await first).value).toBe(7);
    await last;
  }
  expect(called).toBe(false);
  expect(trace).toEqual(["last"]);
});

it("drops a withdrawn command and its rejection reason while the queue is stalled", async () => {
  const queue = new SerialQueue();
  const first = Promise.withResolvers<void>();
  const running = queue.run(() => first.promise);
  async function withdraw() {
    const payload = {};
    const reason = {};
    const controller = new AbortController();
    const result = queue.run(() => payload, controller.signal);
    controller.abort(reason);
    expect(await result.catch((error: unknown) => error)).toBe(reason);
    return [new WeakRef(payload), new WeakRef(reason)];
  }
  try {
    const references = await withdraw();
    const collect = globalThis.gc;
    if (!collect) throw new Error("Retention tests require --expose-gc");
    for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      collect();
    }
    expect(references.map((reference) => reference.deref())).toEqual([undefined, undefined]);
  } finally {
    first.resolve();
    await running;
  }
});
