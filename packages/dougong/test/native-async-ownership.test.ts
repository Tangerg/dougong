import { expect, it } from "vitest";
import { createResourceAuthority, createHost, definePlugin, service } from "../src/index";

const resourceAuthority = createResourceAuthority();

it("an asynchronous disposer must retain ownership until a native Promise settles", async () => {
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
            lifetime.use({
              [Symbol.asyncDispose]() {
                consumerReleased = true;
                return cleanup.promise;
              },
            });
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
});

it("a foreground borrow must wait for the native callback Promise", async () => {
  const capability = service<object>("audit/borrow");
  const pending = Promise.withResolvers<void>();
  // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand.
  Object.defineProperty(pending.promise, "then", { value: undefined });
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          provides: { capability },
          setup: () => ({ capability: {} }),
        }),
      },
    ],
  });
  await host.start();
  const borrowing = host.use(capability, () => pending.promise);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let stopOutcome = "resolved";
  await host.stop().catch((error: { code?: string }) => {
    stopOutcome = error.code ?? "rejected";
  });
  pending.resolve();
  await borrowing;
  await host.stop();
  expect(stopOutcome).toBe("HOST_BUSY");
});
