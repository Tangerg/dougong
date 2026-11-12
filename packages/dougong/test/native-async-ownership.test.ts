import { expect, it } from "vitest";
import { createResourceAuthority, createHost, definePlugin, service } from "../src/index";

const resourceAuthority = createResourceAuthority();

function structuralResult<Value>(promise: Promise<Value>) {
  return {
    // oxlint-disable-next-line unicorn/no-thenable -- The adapter must not replace the nested Promise's actual settlement.
    then(resolve: (value: Promise<Value>) => void) {
      resolve(promise);
    },
  };
}

it.each(["async disposer", "deferred thenable"] as const)(
  "a %s must retain ownership until its native Promise settles",
  async (registration) => {
    const provider = service<object>("audit/provider");
    const cleanup = Promise.withResolvers<void>();
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand.
    Object.defineProperty(cleanup.promise, "then", { value: undefined });
    let providerReleased = false;
    let consumerReleased = false;
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "provider",
          plugin: definePlugin({
            name: "provider",
            provides: { provider },
            setup({ lifetime }) {
              lifetime.defer(() => {
                providerReleased = true;
              });
              return { provider: {} };
            },
          }),
        },
        {
          id: "consumer",
          plugin: definePlugin({
            name: "consumer",
            requires: { provider },
            setup({ lifetime }) {
              const beginCleanup = () => {
                consumerReleased = true;
                return cleanup.promise;
              };
              if (registration === "deferred thenable")
                lifetime.defer(() => structuralResult(beginCleanup()));
              else lifetime.use({ [Symbol.asyncDispose]: beginCleanup });
            },
          }),
        },
      ],
    });
    await host.start();
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observed = { consumerReleased, providerReleased, stopped, status: host.status };
    cleanup.resolve();
    await stopping;
    expect(observed).toEqual({
      consumerReleased: true,
      providerReleased: false,
      stopped: false,
      status: "stopping",
    });
  },
);

it.each([false, true])(
  "a foreground borrow must wait for the native callback Promise (structural wrapper: %s)",
  async (wrapped) => {
    const capability = service<object>("audit/borrow");
    const pending = Promise.withResolvers<void>();
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand.
    Object.defineProperty(pending.promise, "then", { value: undefined });
    let providerReleased = false;
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            provides: { capability },
            setup({ lifetime }) {
              lifetime.defer(() => {
                providerReleased = true;
              });
              return { capability: {} };
            },
          }),
        },
      ],
    });
    await host.start();
    const borrowing = host.use(capability, (): unknown =>
      wrapped ? structuralResult(pending.promise) : pending.promise,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    let stopOutcome = "resolved";
    await host.stop().catch((error: { code?: string }) => {
      stopOutcome = error.code ?? "rejected";
    });
    const beforeSettlement = { stopOutcome, providerReleased };
    pending.resolve();
    await borrowing;
    await host.stop();
    expect(beforeSettlement).toEqual({ stopOutcome: "HOST_BUSY", providerReleased: false });
  },
);
