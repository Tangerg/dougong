import { expect, it, vi } from "vitest";
import { resolveValue } from "../src/advanced";

class LocalPromise<Value> extends Promise<Value> {}

it.each([
  { kind: "native", outcome: "fulfilled" },
  { kind: "native", outcome: "rejected" },
  { kind: "subclass", outcome: "fulfilled" },
  { kind: "subclass", outcome: "rejected" },
] as const)(
  "keeps a nested $kind Promise authoritative after structural fulfillment ($outcome)",
  async ({ kind, outcome }) => {
    const pending =
      kind === "native" ? Promise.withResolvers<string>() : LocalPromise.withResolvers<string>();
    const shadow = vi.fn<(resolve: (value: string) => void) => void>((resolve) =>
      resolve("shadow"),
    );
    // oxlint-disable-next-line unicorn/no-thenable -- A native Promise's shadow method must not own settlement at any depth.
    Object.defineProperty(pending.promise, "then", { value: shadow });
    const failure = new Error("actual native rejection");
    const ignoredFailure = new Error("a later structural outcome must be ignored");
    let result: unknown = pending.promise;
    for (let depth = 0; depth < 2; depth++) {
      const nested = result;
      result = {
        // oxlint-disable-next-line unicorn/no-thenable -- Structural resolution may hand off another asynchronous protocol.
        then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
          resolve(nested);
          reject(ignoredFailure);
          throw ignoredFailure;
        },
      };
    }
    let settled = false;
    const resolving = resolveValue(result).then(
      (receipt) => {
        settled = true;
        return { status: "fulfilled", value: receipt.value } as const;
      },
      (error: unknown) => {
        settled = true;
        return { status: "rejected", error } as const;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(shadow).not.toHaveBeenCalled();
    } finally {
      if (outcome === "fulfilled") pending.resolve("actual");
      else pending.reject(failure);
      await expect(resolving).resolves.toEqual(
        outcome === "fulfilled"
          ? { status: "fulfilled", value: "actual" }
          : { status: "rejected", error: failure },
      );
    }
  },
);

it("preserves a nested native fulfillment without resolving its data again", async () => {
  let reads = 0;
  const payload = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "then" && ++reads > 1) throw new Error("fulfilled data resolved twice");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const fulfilled = Promise.resolve(payload);
  const result = {
    // oxlint-disable-next-line unicorn/no-thenable -- The structural boundary must preserve an already resolved native payload.
    then(resolve: (value: Promise<object>) => void) {
      resolve(fulfilled);
    },
  };
  const receipt = await resolveValue<unknown>(result);
  expect(receipt.value).toBe(payload);
  expect(reads).toBe(1);
});

it("captures the next structural protocol before the resolving callback can replace it", async () => {
  let reads = 0;
  const follow = vi.fn<(resolve: (value: string) => void) => void>((resolve) =>
    resolve("captured"),
  );
  const replacement = vi.fn<() => void>();
  const nested = {
    // oxlint-disable-next-line unicorn/no-thenable -- Getter timing is part of structural Promise resolution.
    get then() {
      reads++;
      return follow;
    },
  };
  const result = {
    // oxlint-disable-next-line unicorn/no-thenable -- The supplier may change its returned object after resolving.
    then(resolve: (value: typeof nested) => void) {
      resolve(nested);
      // oxlint-disable-next-line unicorn/no-thenable -- This mutation must not replace the protocol already captured at fulfillment.
      Object.defineProperty(nested, "then", { value: replacement });
    },
  };
  expect((await resolveValue<unknown>(result)).value).toBe("captured");
  expect(reads).toBe(1);
  expect(follow).toHaveBeenCalledOnce();
  expect(follow.mock.contexts[0]).toBe(nested);
  expect(replacement).not.toHaveBeenCalled();
});

it("does not inspect later fulfillment values after accepting structural rejection", async () => {
  const failure = new Error("first structural rejection");
  const read = vi.fn<() => never>(() => {
    throw new Error("the discarded value must not enter resolution");
  });
  // oxlint-disable-next-line unicorn/no-thenable -- A rejected supplier cannot start another protocol through a later value.
  const discarded = Object.defineProperty({}, "then", { get: read });
  const result = {
    // oxlint-disable-next-line unicorn/no-thenable -- A structural supplier must not advance an outcome after rejecting it.
    then(resolve: (value: object) => void, reject: (error: unknown) => void) {
      reject(failure);
      resolve(discarded);
      throw new Error("late supplier exception");
    },
  };
  await expect(resolveValue<unknown>(result)).rejects.toBe(failure);
  expect(read).not.toHaveBeenCalled();
});

it("preserves an unreadable result prototype failure without trying another protocol", async () => {
  const failure = new Error("result prototype became inaccessible");
  const readPrototype = vi.fn<() => object | null>(() => {
    throw failure;
  });
  const read = vi.fn<() => undefined>();
  const result = new Proxy({}, { getPrototypeOf: readPrototype, get: read });

  await expect(resolveValue(result)).rejects.toBe(failure);
  expect(readPrototype).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});
