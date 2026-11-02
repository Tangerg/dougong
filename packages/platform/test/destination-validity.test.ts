import { expect, it, vi } from "vitest";
import { createHost, definePlugin } from "dougong";
import { createPlatform, type Loader } from "../src";
import { deferred, emptyPlugin, nextTurn, select } from "./fixtures";

it.each([
  { stage: "load admission", destination: "group" },
  { stage: "loader", destination: "group" },
  { stage: "load admission", destination: "quarantine" },
  { stage: "loader", destination: "quarantine" },
] as const)(
  "withdraws pending $stage when the destination becomes unavailable through $destination",
  async ({ stage, destination }) => {
    const native = definePlugin({
      name: "native",
      setup({ lifetime }) {
        if (destination === "quarantine")
          lifetime.defer(() => {
            throw new Error("release failed");
          });
      },
    });
    const host = createHost({
      groups: [{ id: "delivery" }],
      installations: [{ id: "native", plugin: native }],
    });
    await host.start();
    const group = host.group("delivery")!;
    const entered = deferred<AbortSignal>();
    const resume = deferred();
    const wait = (signal: AbortSignal) => {
      entered.resolve(signal);
      return resume.promise;
    };
    const module = { default: emptyPlugin("sample") };
    const load = vi.fn<Loader<string>["load"]>((_reference, signal) =>
      stage === "loader" ? wait(signal).then(() => module) : module,
    );
    const platform = createPlatform({
      id: "loading",
      host,
      group,
      apiVersion: "1.0.0",
      loader: { load },
      authorizer: {
        authorize: ({ operation }, signal) =>
          operation === "load" && stage === "load admission" ? wait(signal) : undefined,
      },
    });
    const target = await select(platform, "sample", "sample");
    const attempt = platform.activate([target]).catch((error: unknown) => error);
    const signal = await entered.promise;
    try {
      const unrelated = host.change();
      unrelated.group("unrelated");
      await host.apply(await host.plan(unrelated));
      expect(signal.aborted).toBe(false);

      let invalidation: unknown;
      if (destination === "group") {
        const removal = host.change();
        removal.removeGroup(group);
        invalidation = await host.apply(await host.plan(removal));
      } else {
        invalidation = await host.stop().catch((error: unknown) => error);
      }
      expect(invalidation).toMatchObject(
        destination === "group"
          ? { stateRevision: host.stateRevision }
          : { code: "HOST_QUARANTINED" },
      );
      const code = destination === "group" ? "REGISTRATION_UNAVAILABLE" : "PLATFORM_UNAVAILABLE";
      expect(await Promise.race([attempt, nextTurn().then(() => "still loading")])).toMatchObject({
        code,
      });
      expect(signal.aborted).toBe(true);
      expect(target.status).toBe("failed");
      expect(target.error?.code).toBe(code);
      expect(target.installation).toBeUndefined();
      expect(load).toHaveBeenCalledTimes(stage === "loader" ? 1 : 0);
    } finally {
      resume.resolve();
      await attempt;
      await platform[Symbol.asyncDispose]();
      if (destination === "group") await host.stop();
    }
  },
);
