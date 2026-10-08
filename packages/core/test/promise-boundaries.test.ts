import { expect, it, vi } from "vitest";
import { createHost, SnapshotPublisher } from "../src";

it.each(["object", "function"] as const)(
  "observes the captured %s thenable after rejecting Group configuration",
  async (kind) => {
    const failure = new Error("async configuration failed");
    const observe = vi.fn<(resolve: unknown, reject: (error: unknown) => void) => void>(
      (_resolve, reject) => reject(failure),
    );
    let reads = 0;
    const result = new Proxy(kind === "object" ? {} : () => undefined, {
      get(target, key, receiver) {
        if (key === "then") return ++reads === 1 ? observe : undefined;
        return Reflect.get(target, key, receiver);
      },
    });
    const host = createHost();

    expect(() => host.group("async", () => result)).toThrow("Group configure must be synchronous");
    expect(observe).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.contexts[0]).toBe(result);
    expect(reads).toBe(1);
    expect(host.diagnostics.get().groups.size).toBe(1);
  },
);

it.each(["object", "function"] as const)(
  "observes the captured %s thenable from a snapshot subscriber",
  async (kind) => {
    const failure = new Error("async subscriber failed");
    const observe = vi.fn<(resolve: unknown, reject: (error: unknown) => void) => void>(
      (_resolve, reject) => reject(failure),
    );
    let reads = 0;
    const result = new Proxy(kind === "object" ? {} : () => undefined, {
      get(target, key, receiver) {
        if (key === "then") return ++reads === 1 ? observe : undefined;
        return Reflect.get(target, key, receiver);
      },
    });
    const report = vi.fn<(error: unknown) => void>();
    const publisher = new SnapshotPublisher(() => 1, report);
    const subscription = publisher.view.subscribe(() => result);

    publisher.invalidate();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      new TypeError("Snapshot subscribers must be synchronous"),
    );
    expect(observe).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.contexts[0]).toBe(result);
    expect(reads).toBe(1);
    subscription.dispose();
    publisher.dispose();
  },
);
