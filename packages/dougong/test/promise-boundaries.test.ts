import { createHost, definePlugin, service } from "../src/index";
import { expect, it, vi } from "vitest";
import { SnapshotPublisher } from "../src/observation/snapshot-view";
import { captureDisposer } from "../src/contracts/resource";

it.each(["object", "function"] as const)(
  "observes the captured %s thenable after rejecting an asynchronous synchronous disposer",
  async (kind) => {
    const failure = new Error("asynchronous cleanup failed");
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
    const release = captureDisposer({ [Symbol.dispose]: () => result });
    expect(() => release()).toThrow("synchronous");
    expect(observe).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.contexts[0]).toBe(result);
    expect(reads).toBe(1);
  },
);

it.each(["object", "function"] as const)(
  "observes the captured %s thenable from a snapshot subscriber",
  async (kind) => {
    const failure = new Error("asynchronous subscriber failed");
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
    using _subscription = publisher.view.subscribe(() => result);
    publisher.invalidate();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      new TypeError("Snapshot subscribers must be synchronous"),
    );
    expect(observe).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.contexts[0]).toBe(result);
    expect(reads).toBe(1);
    publisher[Symbol.dispose]();
  },
);

it("settles the public service callback result exactly once, within the borrow", async () => {
  const value = service<number>("borrow/value");
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup: () => ({ value: 1 }),
        }),
      },
    ],
  });
  await host.start();
  let reads = 0;
  const result = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "then" && ++reads > 1) throw new Error("callback result was assimilated again");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  expect((await host.use(value, () => result)).value).toBe(result);
  expect(reads).toBe(1);
  await host.stop();
});
