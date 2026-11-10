import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin, service } from "../src";
import { Lifetime } from "../src/lifetime/lifetime";

const resourceAuthority = createResourceAuthority();

it("retains a consumer and its provider when a synchronous disposer hides a pending native Promise", async () => {
  const dependency = service<object>("native-disposal/dependency");
  const pending = Promise.withResolvers<void>();
  // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native brand required by this regression.
  Object.defineProperty(pending.promise, "then", { value: undefined });
  let releases = 0;
  const resource = {
    [Symbol.dispose]() {
      releases++;
      return pending.promise;
    },
  };
  const releaseProvider = vi.fn<() => void>();
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { dependency },
          setup({ lifetime }) {
            lifetime.defer(releaseProvider);
            return { dependency: {} };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { dependency },
          setup({ lifetime }) {
            lifetime.use(resource);
          },
        }),
      },
    ],
  });
  const competing = new Lifetime({
    resourceAuthority,
    label: "competing",
    report: () => undefined,
  });
  await host.start();
  try {
    await expect(host.stop()).rejects.toThrow(/quarantin/);
    expect(host.status).toBe("quarantined");
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(() => competing.use(resource)).toThrow("Resource already has a Lifetime owner");
    pending.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.status).toBe("quarantined");
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(() => competing.use(resource)).toThrow("Resource already has a Lifetime owner");
    expect(releases).toBe(1);
  } finally {
    pending.resolve();
    await competing.dispose();
  }
});
