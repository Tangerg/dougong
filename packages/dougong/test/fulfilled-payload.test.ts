import { expect, it } from "vitest";
import { createResourceAuthority, createHost, definePlugin, service } from "../src/index";
import { Lifetime } from "../src/lifetime/lifetime";

const resourceAuthority = createResourceAuthority();

it("acquire must not discard an already-fulfilled native Promise resource on a second then read", async () => {
  let reads = 0;
  let releases = 0;
  const resource = new Proxy(
    {
      [Symbol.dispose]() {
        releases++;
      },
    },
    {
      get(target, key, receiver) {
        if (key === "then" && ++reads > 1) throw new Error("resource assimilated twice");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const ready = Promise.resolve(resource);
  expect(await ready).toBe(resource);
  expect(reads).toBe(1);
  const owner = new Lifetime({ resourceAuthority, label: "fulfilled-resource", report() {} });
  let receipt: unknown;
  try {
    receipt = await owner.acquire(() => ready);
  } catch (error) {
    receipt = error;
  }
  await owner.dispose();
  expect({
    receivedResource: (receipt as { resource?: unknown })?.resource === resource,
    reads,
    releases,
    error: receipt instanceof Error ? receipt.message : undefined,
  }).toEqual({ receivedResource: true, reads: 1, releases: 1, error: undefined });
});

it("a borrow must deliver the fulfilled callback payload without adopting it again", async () => {
  const capability = service<object>("fulfilled/value");
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
  let reads = 0;
  const payload = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "then" && ++reads > 1) throw new Error("payload assimilated twice");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const ready = Promise.resolve(payload);
  expect(await ready).toBe(payload);
  let result: unknown;
  try {
    result = await host.use(capability, () => ready);
  } catch (error) {
    result = error;
  }
  await host.stop();
  expect((result as { readonly value?: unknown })?.value).toBe(payload);
  expect(Object.isFrozen(result)).toBe(true);
  expect(reads).toBe(1);
});

it("spawn must preserve a fulfilled native Promise payload", async () => {
  let reads = 0;
  const failures: unknown[] = [];
  const payload = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "then" && ++reads > 1) throw new Error("task payload assimilated twice");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const ready = Promise.resolve(payload);
  const owner = new Lifetime({
    resourceAuthority,
    label: "fulfilled-task",
    report(error) {
      failures.push(error);
    },
  });
  let result: unknown;
  try {
    result = await owner.spawn(() => ready).result;
  } catch (error) {
    result = error;
  }
  await owner.dispose();
  expect((result as { readonly value?: unknown })?.value).toBe(payload);
  expect(Object.isFrozen(result)).toBe(true);
  expect(reads).toBe(1);
  expect(failures).toEqual([]);
});
