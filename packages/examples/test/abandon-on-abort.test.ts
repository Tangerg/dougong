import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { abandonOnAbort } from "../src/abandon-on-abort";

describe("explicitly abandoning an operation on abort", () => {
  it("does not register listeners or start work on repeated pre-cancelled calls", async () => {
    const signal = AbortSignal.abort();
    const start = vi.fn<() => Promise<string>>(() => Promise.resolve("unused"));

    for (let attempt = 0; attempt < 32; attempt++) {
      await expect(abandonOnAbort(signal, start)).rejects.toBe(signal.reason);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }

    expect(start).not.toHaveBeenCalled();
  });

  it("does not start work when aborted immediately after registration", async () => {
    const controller = new AbortController();
    const reason = new Error("retired");
    const start = vi.fn<() => Promise<string>>(() => Promise.resolve("unused"));
    const result = abandonOnAbort(controller.signal, start);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not start work when an earlier microtask aborts the signal", async () => {
    const controller = new AbortController();
    const reason = new Error("retired before start");
    const start = vi.fn<() => Promise<string>>(() => Promise.resolve("unused"));
    queueMicrotask(() => controller.abort(reason));

    const result = abandonOnAbort(controller.signal, start);

    await expect(result).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not yield between checking cancellation and starting work", async () => {
    const controller = new AbortController();
    const reason = new Error("retired in the next microtask");
    const operation = Promise.withResolvers<void>();
    const abortedAtStart: boolean[] = [];
    const result = abandonOnAbort(controller.signal, () => {
      abortedAtStart.push(controller.signal.aborted);
      return operation.promise;
    });

    // With separate check/start reactions this abort runs between them.
    queueMicrotask(() => controller.abort(reason));
    await expect(result).rejects.toBe(reason);
    operation.resolve();
    await setImmediate();

    expect(abortedAtStart).toEqual([false]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("returns completion and removes only its own listener", async () => {
    const controller = new AbortController();
    const unrelated = vi.fn<(event: Event) => void>();
    controller.signal.addEventListener("abort", unrelated, { once: true });
    const result = abandonOnAbort(controller.signal, () => Promise.resolve("complete"));

    await expect(result).resolves.toBe("complete");

    expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
    controller.abort();
    expect(unrelated).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe("complete");
  });

  it("returns the original failure and releases the listener", async () => {
    const controller = new AbortController();
    const failure = new Error("operation failed");
    const result = abandonOnAbort(controller.signal, () => Promise.reject(failure));

    await expect(result).rejects.toBe(failure);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await expect(result).rejects.toBe(failure);
  });

  it("observes synchronous start failures and releases the listener", async () => {
    const controller = new AbortController();
    const failure = new Error("start failed");
    const result = abandonOnAbort(controller.signal, () => {
      throw failure;
    });

    await expect(result).rejects.toBe(failure);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("keeps cancellation when start itself aborts before returning a result", async () => {
    const controller = new AbortController();
    const reason = new Error("retired inside start");
    const start = vi.fn<() => Promise<string>>(() => {
      controller.abort(reason);
      return Promise.resolve("late success");
    });

    await expect(abandonOnAbort(controller.signal, start)).rejects.toBe(reason);
    await setImmediate();

    expect(start).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("settles cancellation once when the operation fulfills in the next microtask", async () => {
    const controller = new AbortController();
    const reason = new Error("retired before completion");
    const started = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<string>();
    const result = abandonOnAbort(controller.signal, () => {
      started.resolve();
      return operation.promise;
    });
    const fulfilled = vi.fn<(value: string) => void>();
    const rejected = vi.fn<(error: unknown) => void>();
    const observed = result.then(fulfilled, rejected);
    await started.promise;

    queueMicrotask(() => controller.abort(reason));
    queueMicrotask(() => operation.resolve("late success"));
    await observed;
    await setImmediate();

    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("settles completion once when the signal aborts in the next microtask", async () => {
    const controller = new AbortController();
    const result = abandonOnAbort(controller.signal, () => Promise.resolve("complete"));
    const fulfilled = vi.fn<(value: string) => void>(() => {
      queueMicrotask(() => controller.abort(new Error("retired after completion")));
    });
    const rejected = vi.fn<(error: unknown) => void>();

    await result.then(fulfilled, rejected);
    await setImmediate();

    expect(fulfilled).toHaveBeenCalledExactlyOnceWith("complete");
    expect(rejected).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("observes a late rejection after the caller has stopped waiting", async () => {
    const controller = new AbortController();
    const reason = new Error("retired");
    const failure = new Error("late operation failure");
    const started = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<never>();
    const unhandled = vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
    process.on("unhandledRejection", unhandled);

    try {
      const result = abandonOnAbort(controller.signal, () => {
        started.resolve();
        return operation.promise;
      });
      await started.promise;
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

      operation.reject(failure);
      await setImmediate();

      expect(unhandled).not.toHaveBeenCalled();
      await expect(result).rejects.toBe(reason);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });
});
