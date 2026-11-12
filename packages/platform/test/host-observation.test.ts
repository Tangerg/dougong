import {
  createHost,
  createResourceAuthority,
  definePlugin,
  type Disposable,
  type LifetimeContext,
} from "dougong";
import { expect, it, vi } from "vitest";
import { createPlatform, MemoryLoader } from "../src";
import { HostObservation } from "../src/activation/host-observation";
import { withDiagnosticsSubscription } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it("joins registration-time progress and revokes callbacks before one reentrant withdrawal", async () => {
  let lifetime!: LifetimeContext;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            lifetime = context.lifetime;
          },
        }),
      },
    ],
  });
  await host.start();
  const synchronize = vi.fn<() => void>();
  let observation!: HostObservation;
  const withdraw = vi.fn<() => void>();
  const source = withDiagnosticsSubscription(host, (listener) => {
    const subscription = host.diagnostics.subscribe(listener);
    lifetime.defer(() => undefined);
    return {
      [Symbol.dispose]() {
        withdraw();
        listener();
        observation.close();
        subscription[Symbol.dispose]();
      },
    };
  });
  try {
    observation = new HostObservation(source.diagnostics, synchronize);
    expect(synchronize).toHaveBeenCalledOnce();
    observation.close();
    observation.close();
    expect(withdraw).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledOnce();
  } finally {
    observation?.close();
    await host.stop();
  }
});

it("captures the accepted Host subscription's disposer and receiver once", async () => {
  const host = createHost({ resourceAuthority });
  const replaced = vi.fn<() => void>(() => {
    throw new Error("replacement disposer must not control the accepted subscription");
  });
  const withdraw = vi.fn<(this: Disposable) => void>();
  let handle!: Disposable;
  const source = withDiagnosticsSubscription(host, (listener) => {
    const subscription = host.diagnostics.subscribe(listener);
    withdraw.mockImplementation(function (this: Disposable) {
      expect(this).toBe(handle);
      subscription[Symbol.dispose]();
    });
    handle = { [Symbol.dispose]: withdraw };
    return handle;
  });
  const platform = createPlatform({
    id: "captured-observation",
    host: source,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map<string, unknown>()),
  });
  Object.defineProperty(handle, Symbol.dispose, { value: replaced });
  await platform[Symbol.asyncDispose]();
  await platform[Symbol.asyncDispose]();
  expect(withdraw).toHaveBeenCalledOnce();
  expect(replaced).not.toHaveBeenCalled();
  await host.stop();
});

it.each([false, true])(
  "publishes terminal availability before external withdrawal (failure: %s)",
  async (fails) => {
    const host = createHost({ resourceAuthority });
    const failure = new Error("withdrawal failed after reading final state");
    const observed: Array<{ readonly live: string; readonly projected: string }> = [];
    const source = withDiagnosticsSubscription(host, (listener) => {
      const subscription = host.diagnostics.subscribe(listener);
      return {
        [Symbol.dispose]() {
          observed.push({
            live: platform.status,
            projected: platform.diagnostics.get().status,
          });
          subscription[Symbol.dispose]();
          if (fails) throw failure;
        },
      };
    });
    const platform = createPlatform({
      id: "terminal-observation",
      host: source,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map<string, unknown>()),
    });
    const notifications: string[] = [];
    const subscription = platform.diagnostics.subscribe(() => {
      notifications.push(platform.diagnostics.get().status);
    });
    try {
      const outcome = await platform[Symbol.asyncDispose]().then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(outcome).toEqual(
        fails ? { status: "rejected", error: failure } : { status: "fulfilled" },
      );
      expect(observed).toEqual([{ live: "disposed", projected: "disposed" }]);
      expect(notifications).toEqual(["disposing", "disposed"]);
    } finally {
      subscription[Symbol.dispose]();
      await host.stop();
    }
  },
);

it.each(["throw", "asynchronous result"] as const)(
  "retains the disposal receipt after Host subscription withdrawal fails with %s",
  async (mode) => {
    const host = createHost({ resourceAuthority });
    const failure = new Error("subscription withdrawal failed");
    const withdraw = vi.fn<() => unknown>();
    const source = withDiagnosticsSubscription(host, (listener) => {
      const subscription = host.diagnostics.subscribe(listener);
      withdraw.mockImplementation(() => {
        subscription[Symbol.dispose]();
        if (mode === "asynchronous result") return Promise.reject(failure);
        throw failure;
      });
      return { [Symbol.dispose]: withdraw };
    });
    const platform = createPlatform({
      id: "failed-observation",
      host: source,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map<string, unknown>()),
    });
    await host.start();
    try {
      const first = platform[Symbol.asyncDispose]();
      const rejection: unknown = await first.catch((error: unknown) => error);
      expect(rejection).toEqual(
        mode === "throw"
          ? failure
          : new TypeError("Host diagnostics subscriptions must dispose synchronously"),
      );
      expect(platform.status).toBe("disposed");
      expect(platform.diagnostics.get().status).toBe("disposed");
      const repeated = platform[Symbol.asyncDispose]();
      expect(repeated).toBe(first);
      await expect(repeated).rejects.toBe(rejection);
      expect(withdraw).toHaveBeenCalledOnce();
      expect(host.status).toBe("running");
    } finally {
      await host.stop();
    }
  },
);
