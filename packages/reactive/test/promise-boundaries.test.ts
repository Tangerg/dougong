import { expect, it, vi } from "vitest";
import { batch, computed, signal } from "../src";

it.each(["batch", "computed", "subscriber"] as const)(
  "observes the thenable captured at the %s boundary",
  async (boundary) => {
    const failure = new Error("async reactive callback failed");
    const observe = vi.fn<(resolve: unknown, reject: (error: unknown) => void) => void>(
      (_resolve, reject) => reject(failure),
    );
    let reads = 0;
    const result = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (key === "then") return ++reads === 1 ? observe : undefined;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const source = signal(0);
    const subscription = boundary === "subscriber" ? source.subscribe(() => result) : undefined;

    expect(() => {
      if (boundary === "batch") batch(() => result);
      else if (boundary === "computed") computed(() => result).get();
      else source.set(1);
    }).toThrow(TypeError);
    expect(observe).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.contexts[0]).toBe(result);
    expect(reads).toBe(1);
    subscription?.dispose();
  },
);
