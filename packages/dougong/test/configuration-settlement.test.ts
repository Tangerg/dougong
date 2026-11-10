import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin } from "../src/index";

const resourceAuthority = createResourceAuthority();

class NativeValidation extends Promise<StandardSchemaV1.Result<number>> {}

it.each(["fulfilled", "rejected"] as const)(
  "uses the native validator settlement when its public then claims success (%s)",
  async (outcome) => {
    const pending = NativeValidation.withResolvers<StandardSchemaV1.Result<number>>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("native validation failed");
    const publicThen = vi.fn<(resolve: (value: StandardSchemaV1.Result<number>) => void) => void>(
      (resolve) => resolve({ value: 999 }),
    );
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native subclass brand.
    Object.defineProperty(pending.promise, "then", { value: publicThen });
    const schema: StandardSchemaV1<number, number> = {
      "~standard": {
        version: 1,
        vendor: "configuration-settlement",
        validate() {
          entered.resolve();
          return pending.promise;
        },
      },
    };
    const received: number[] = [];
    const host = createHost({
      resourceAuthority,
      installations: [
        {
          id: "configured",
          configuration: 1,
          plugin: definePlugin({
            name: "configured",
            configuration: schema,
            setup(_context, value) {
              received.push(value);
            },
          }),
        },
      ],
    });
    let settled = false;
    const starting = host.start().then(
      () => {
        settled = true;
        return { status: "fulfilled" } as const;
      },
      (reason: unknown) => {
        settled = true;
        return { status: "rejected", reason } as const;
      },
    );
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = { settled, configurations: [...received], calls: publicThen.mock.calls.length };
    if (outcome === "fulfilled") pending.resolve({ value: 42 });
    else pending.reject(failure);

    try {
      const result = await starting;
      expect(before).toEqual({ settled: false, configurations: [], calls: 0 });
      expect(publicThen).not.toHaveBeenCalled();
      expect(result).toEqual(
        outcome === "fulfilled" ? { status: "fulfilled" } : { status: "rejected", reason: failure },
      );
      expect(received).toEqual(outcome === "fulfilled" ? [42] : []);
    } finally {
      await host.stop();
    }
  },
);
