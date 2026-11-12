import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createHost, createResourceAuthority, definePlugin, service } from "../src";

describe.each(["fulfills", "rejects"] as const)("actual setup %s", (settlement) => {
  it.each(["fulfillment", "rejection", "unreadable then"] as const)(
    "ignores public result %s when observing preparation",
    async (shadow) => {
      const authority = createResourceAuthority();
      const value = service<object>("setup-settlement/value");
      const actualValue = {};
      const forgedValue = {};
      const completion = Promise.withResolvers<{ value: object }>();
      const entered = Promise.withResolvers<void>();
      const failure = new Error("actual setup failed");
      const shadowFailure = new Error("public result must not decide setup completion");
      const release = vi.fn<() => void>();
      let decorated = false;
      let thenReads = 0;
      const host = createHost({
        resourceAuthority: {
          claim: (resource) => authority.claim(resource),
          markControlHandle(handle) {
            authority.markControlHandle(handle);
            if (decorated || !("result" in handle)) return;
            decorated = true;
            const result = (handle as { readonly result: Promise<unknown> }).result;
            Object.defineProperty(result, "constructor", { value: Object });
            // oxlint-disable-next-line unicorn/no-thenable -- A public Promise method cannot own the Instance's preparation outcome.
            Object.defineProperty(result, "then", {
              get() {
                thenReads++;
                if (shadow === "unreadable then") throw shadowFailure;
                return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
                  if (shadow === "rejection") reject(shadowFailure);
                  else resolve({ value: { value: forgedValue } });
                };
              },
            });
          },
        },
        installations: [
          {
            id: "provider",
            plugin: definePlugin({
              name: "provider",
              provides: { value },
              setup({ lifetime }) {
                lifetime.defer(release);
                entered.resolve();
                return completion.promise;
              },
            }),
          },
        ],
      });
      let outcome: "pending" | "fulfilled" | "rejected" = "pending";
      const starting = host.start();
      const observed = starting.then(
        () => (outcome = "fulfilled"),
        () => (outcome = "rejected"),
      );
      try {
        await entered.promise;
        await setImmediate();
        expect(decorated).toBe(true);
        expect(thenReads).toBe(0);
        expect(outcome).toBe("pending");
        expect(host.status).toBe("starting");
        expect(host.stateRevision).toBe(0);
        expect(release).not.toHaveBeenCalled();
        if (settlement === "fulfills") completion.resolve({ value: actualValue });
        else completion.reject(failure);
        const rejection: unknown = await starting.catch((error: unknown) => error);
        expect(outcome).toBe(settlement === "fulfills" ? "fulfilled" : "rejected");
        expect(host.status).toBe(settlement === "fulfills" ? "running" : "stopped");
        expect(thenReads).toBe(0);
        const result =
          settlement === "fulfills"
            ? (await host.use(value, (current) => current)).value
            : (rejection as Error).cause;
        expect(result).toBe(settlement === "fulfills" ? actualValue : failure);
      } finally {
        completion.resolve({ value: actualValue });
        await observed;
        if (host.status === "running") await host.stop();
      }
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
