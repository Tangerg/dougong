import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin } from "dougong";
import { createPlatform } from "../src";
import { Preparation } from "../src/activation/preparation";
import { deferred, emptyPlugin, nextTurn, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();

class LocalPromise<T> extends Promise<T> {}

const promiseKinds = ["native", "subclass"] as const;
type PromiseKind = (typeof promiseKinds)[number];

it.each(["start", "waitFor"] as const)(
  "Preparation.%s waits for native settlement and transfers its immutable receipt",
  async (method) => {
    const pending = deferred<{ source: string }>();
    const actual = { source: "actual" };
    const publicThen = shadowFulfillment(pending.promise, { source: "shadow" });
    const signal = new AbortController().signal;
    const result =
      method === "start"
        ? Preparation.start(() => pending.promise).wait(signal)
        : Preparation.waitFor(() => pending.promise, signal);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await nextTurn();
      expect(settled).toBe(false);
      pending.resolve(actual);
      const receipt = await result;

      expect(receipt.value).toBe(actual);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(publicThen).not.toHaveBeenCalled();
    } finally {
      pending.resolve(actual);
      await result.catch(() => undefined);
    }
  },
);

it("shares one immutable Preparation receipt with current and later waiters", async () => {
  const pending = deferred<object>();
  const value = {};
  const preparation = Preparation.start(() => pending.promise);
  const signal = new AbortController().signal;
  const first = preparation.wait(signal);
  const second = preparation.wait(signal);
  pending.resolve(value);
  const receipt = await first;

  expect(receipt.value).toBe(value);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(await second).toBe(receipt);
  expect(await preparation.wait(signal)).toBe(receipt);
  expect(await preparation.result).toBe(receipt);
});

it.each([
  { kind: "native", phase: "load" },
  { kind: "native", phase: "activate" },
  { kind: "subclass", phase: "load" },
  { kind: "subclass", phase: "activate" },
] as const)(
  "waits for $kind $phase admission instead of accepting a shadow fulfillment",
  async ({ kind, phase }) => {
    const pending = nativeResult<void>(kind);
    const publicThen = shadowFulfillment(pending.promise, undefined);
    const entered = deferred();
    const denial = new Error("Admission denied");
    const setup = vi.fn<() => void>();
    const loaded = vi.fn<() => void>();
    const module = { default: definePlugin({ name: "sample", setup }) };
    const host = createHost({ resourceAuthority });
    const platform = createPlatform({
      id: "admission",
      host,
      apiVersion: "1.0.0",
      loader: {
        load() {
          loaded();
          return module;
        },
      },
      authorizer: {
        authorize({ operation }) {
          if (operation !== phase) return;
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const registration = await select(platform, "sample", "sample");
    await host.start();
    const revision = host.stateRevision;
    let settled = false;
    const outcome = platform.activate([registration]).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered.promise;
      await nextTurn();

      expect(settled).toBe(false);
      expect(host.stateRevision).toBe(revision);
      expect(host.installation(registration.id)).toBeUndefined();
      expect(setup).not.toHaveBeenCalled();
      expect(loaded).toHaveBeenCalledTimes(phase === "load" ? 0 : 1);

      pending.reject(denial);
      expect(await outcome).toEqual({ error: denial });
      await nextTurn();

      expect(publicThen).not.toHaveBeenCalled();
      expect(host.stateRevision).toBe(revision);
      expect(host.installation(registration.id)).toBeUndefined();
      expect(setup).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await outcome;
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it.each([
  { kind: "native", wrapped: false },
  { kind: "native", wrapped: true },
  { kind: "subclass", wrapped: false },
  { kind: "subclass", wrapped: true },
] as const)(
  "waits for a $kind Loader result instead of a shadow module (structural wrapper: $wrapped)",
  async ({ kind, wrapped }) => {
    const setup = vi.fn<() => void>();
    const shadowSetup = vi.fn<() => void>();
    const module = { default: definePlugin({ name: "sample", setup }) };
    const pending = nativeResult<typeof module>(kind);
    const publicThen = shadowFulfillment(pending.promise, {
      default: definePlugin({ name: "sample", setup: shadowSetup }),
    });
    const entered = deferred();
    const host = createHost({ resourceAuthority });
    const platform = createPlatform({
      id: "loader",
      host,
      apiVersion: "1.0.0",
      loader: {
        load() {
          entered.resolve();
          return wrapped
            ? {
                // oxlint-disable-next-line unicorn/no-thenable -- Loader adapters may resolve through another native result.
                then(resolve: (value: typeof pending.promise) => void) {
                  resolve(pending.promise);
                },
              }
            : pending.promise;
        },
      },
    });
    const registration = await select(platform, "sample", "sample");
    await host.start();
    const revision = host.stateRevision;
    let settled = false;
    const outcome = platform.activate([registration]).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered.promise;
      await nextTurn();

      expect(settled).toBe(false);
      expect(host.stateRevision).toBe(revision);
      expect(setup).not.toHaveBeenCalled();
      expect(shadowSetup).not.toHaveBeenCalled();

      pending.resolve(module);
      expect(await outcome).toEqual({
        result: { stateRevision: host.stateRevision, affectedInstallations: [registration.id] },
      });
      expect(setup).toHaveBeenCalledOnce();
      expect(shadowSetup).not.toHaveBeenCalled();
      expect(publicThen).not.toHaveBeenCalled();
      expect(registration.status).toBe("installed");
    } finally {
      pending.resolve(module);
      await outcome;
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it.each(promiseKinds)(
  "validates a fulfilled %s module without resolving its payload again",
  async (kind) => {
    let reads = 0;
    const module = new Proxy(
      { default: emptyPlugin("sample") },
      {
        get(target, key, receiver) {
          if (key === "then" && ++reads > 1) throw new Error("Module payload was resolved twice");
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const pending = nativeResult<typeof module>(kind);
    pending.resolve(module);
    expect(reads).toBe(1);
    const host = createHost({ resourceAuthority });
    const platform = createPlatform({
      id: "fulfilled-module",
      host,
      apiVersion: "1.0.0",
      loader: { load: () => pending.promise },
    });
    const registration = await select(platform, "sample", "sample");
    try {
      await platform.activate([registration]);
      expect(reads).toBe(1);
      expect(registration.status).toBe("installed");
    } finally {
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

function nativeResult<T>(kind: PromiseKind) {
  return kind === "subclass" ? LocalPromise.withResolvers<T>() : Promise.withResolvers<T>();
}

function shadowFulfillment<T>(promise: Promise<T>, value: T) {
  const publicThen = vi.fn<(resolve: (value: T) => void) => void>((resolve) => resolve(value));
  // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native Promise brand required by this regression.
  Object.defineProperty(promise, "then", { value: publicThen });
  return publicThen;
}
