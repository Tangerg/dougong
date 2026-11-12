import { setImmediate } from "node:timers/promises";
import { createHost, createResourceAuthority, definePlugin, type LifetimeContext } from "dougong";
import { resolveValue } from "dougong/advanced";
import { describe, expect, it, vi } from "vitest";
import { acquireForLifetime } from "../src/retired-acquisition";

const shadows = ["fulfillment", "rejection", "unreadable then"] as const;
type Shadow = (typeof shadows)[number];

function decorateResult(result: Promise<unknown>, value: unknown, shadow: Shadow) {
  const failure = new Error("Public Promise methods cannot advance resource handoff");
  const publicThen = vi.fn<
    () => (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => unknown
  >(() => {
    if (shadow === "unreadable then") throw failure;
    return (resolve, reject) =>
      Promise.resolve().then(() => (shadow === "rejection" ? reject(failure) : resolve(value)));
  });
  Object.defineProperty(result, "constructor", { value: Object });
  // oxlint-disable-next-line unicorn/no-thenable -- A public receipt remains a projection of the owned work.
  Object.defineProperty(result, "then", { get: publicThen });
  return publicThen;
}

async function fixture() {
  let lifetime!: LifetimeContext;
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    resourceAuthority: createResourceAuthority(),
    onError: report,
    installations: [
      {
        id: "application",
        plugin: definePlugin({
          name: "application",
          setup(context) {
            lifetime = context.lifetime;
          },
        }),
      },
    ],
  });
  await host.start();
  return {
    host,
    generation: lifetime.child("generation"),
    operations: lifetime.child("operations"),
    report,
  };
}

describe.each(["fulfills", "rejects"] as const)("actual external operation %s", (settlement) => {
  it.each(shadows)("ignores the Task receipt's public %s", async (shadow) => {
    const { host, generation, operations, report } = await fixture();
    const entered = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<object>();
    const resource = {};
    const forged = {};
    const failure = new Error("Actual external operation failed");
    const release = vi.fn<(value: object) => void>();
    let publicThen: ReturnType<typeof decorateResult> | undefined;
    const source: Pick<LifetimeContext, "spawn" | "defer"> = {
      defer: operations.defer,
      spawn(task) {
        const operation = operations.spawn(task);
        publicThen = decorateResult(
          operation.result,
          { value: { status: "acquired", value: forged } },
          shadow,
        );
        return operation;
      },
    };
    let settled = false;
    const result = acquireForLifetime(
      generation,
      source,
      () => {
        entered.resolve();
        return completion.promise;
      },
      release,
    );
    const outcome = result.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(publicThen).not.toHaveBeenCalled();
      if (settlement === "fulfills") completion.resolve(resource);
      else completion.reject(failure);
      expect(await outcome).toEqual({
        value:
          settlement === "fulfills"
            ? { status: "acquired", value: resource }
            : { status: "failed", error: failure },
      });
      expect(publicThen).not.toHaveBeenCalled();
      expect(report.mock.calls).toEqual(settlement === "fulfills" ? [] : [[failure]]);
    } finally {
      completion.resolve(resource);
      await outcome;
      await host.stop();
    }
    expect(release.mock.calls).toEqual(settlement === "fulfills" ? [[resource]] : []);
  });
});

describe.each(["retired", "registration failure"] as const)("%s handoff", (path) => {
  it.each(shadows)(
    "joins reclamation despite the reservation receipt's public %s",
    async (shadow) => {
      const { host, generation, operations, report } = await fixture();
      const controller = new AbortController();
      const retired = new Error("The waiting generation retired");
      const registrationFailure = new Error("Destination rejected registration");
      const resource = {};
      const entered = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<void>();
      const release = vi.fn<(value: object) => Promise<void>>(() => {
        entered.resolve();
        return completion.promise;
      });
      let publicThen: ReturnType<typeof decorateResult> | undefined;
      let taskSettled = false;
      let taskCompletion: Promise<unknown> | undefined;
      const source: Pick<LifetimeContext, "spawn" | "defer"> = {
        spawn(task) {
          const operation = operations.spawn(task);
          taskCompletion = resolveValue(operation.result).then(
            () => {
              taskSettled = true;
            },
            () => {
              taskSettled = true;
            },
          );
          return operation;
        },
        defer(cleanup) {
          const reservation = operations.defer(cleanup);
          return {
            [Symbol.asyncDispose]() {
              const result = resolveValue(reservation[Symbol.asyncDispose]()).then(() => undefined);
              publicThen = decorateResult(result, undefined, shadow);
              return result;
            },
          };
        },
      };
      const destination: Pick<LifetimeContext, "signal" | "defer"> = {
        signal: controller.signal,
        defer() {
          throw registrationFailure;
        },
      };
      let settled = false;
      const result = acquireForLifetime(
        destination,
        source,
        () => {
          if (path === "retired") controller.abort(retired);
          return Promise.resolve(resource);
        },
        release,
      );
      const outcome = result.then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await entered.promise;
        await setImmediate();
        expect(taskSettled).toBe(false);
        expect(settled).toBe(path === "retired");
        expect(publicThen).not.toHaveBeenCalled();
        completion.resolve();
        await taskCompletion;
        expect(await outcome).toEqual(
          path === "retired"
            ? { error: retired }
            : { value: { status: "failed", error: registrationFailure } },
        );
        expect(report.mock.calls).toEqual(path === "retired" ? [] : [[registrationFailure]]);
        expect(publicThen).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledExactlyOnceWith(resource);
      } finally {
        completion.resolve();
        await taskCompletion;
        await outcome;
        await generation[Symbol.asyncDispose]();
        await host.stop();
      }
    },
  );
});
