import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { batch, computed, signal } from "../src";
import { assertSynchronous, captureThenable } from "../src/async-result";

it.each(["batch", "computed", "subscriber"] as const)(
  "rejects a native Promise with a missing or throwing then member at the %s boundary",
  (boundary) => {
    for (const throwing of [false, true]) {
      const pending = Promise.withResolvers<void>();
      const read = vi.fn<() => undefined>(() => {
        if (throwing) throw new Error("The public then getter is not the settlement owner");
        return undefined;
      });
      // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native brand required by this regression.
      Object.defineProperty(pending.promise, "then", { get: read });
      Object.defineProperty(pending.promise, Symbol.toStringTag, {
        value: "Hidden native promise",
      });
      const source = signal(0);
      using _subscription = source.subscribe((): unknown => pending.promise);
      try {
        expect(() => {
          if (boundary === "batch") batch((): unknown => pending.promise);
          else if (boundary === "computed") computed((): unknown => pending.promise).get();
          else source.set(1);
        }).toThrow(/must be synchronous/);
        expect(read).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
      }
    }
  },
);

it("consumes a cross-realm Promise through its captured structural protocol", async () => {
  const pending = runInNewContext("Promise.withResolvers()") as PromiseWithResolvers<string>;
  const then = pending.promise.then;
  const forward = vi.fn<(this: Promise<string>, ...callbacks: unknown[]) => Promise<unknown>>(
    function (this: Promise<string>, ...callbacks: unknown[]) {
      return Reflect.apply(then, this, callbacks);
    },
  );
  // oxlint-disable-next-line unicorn/no-thenable -- The forwarding method keeps the foreign protocol conforming.
  Object.defineProperty(pending.promise, "then", { value: forward });
  const captured = captureThenable(pending.promise)!;
  expect(forward).not.toHaveBeenCalled();
  pending.resolve("foreign value");
  await expect(captured).resolves.toEqual({ value: "foreign value" });
  expect(forward).toHaveBeenCalledOnce();
  expect(forward.mock.contexts[0]).toBe(pending.promise);
});

it.each([false, true])(
  "observes actual native settlement without invoking an overridden then (structural wrapper: %s)",
  async (wrapped) => {
    const pending = Promise.withResolvers<void>();
    const fake = vi.fn<(resolve: (value: unknown) => void) => void>((resolve) =>
      resolve("not settled"),
    );
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native brand required by this regression.
    Object.defineProperty(pending.promise, "then", { value: fake });
    const result = {
      // oxlint-disable-next-line unicorn/no-thenable -- Nesting cannot give the native Promise's public then settlement authority.
      then(resolve: (value: typeof pending.promise) => void) {
        resolve(pending.promise);
      },
    };
    const captured = captureThenable(wrapped ? result : pending.promise)!;
    let settled = false;
    void captured.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake).not.toHaveBeenCalled();
    const failure = new Error("native settlement");
    pending.reject(failure);
    await expect(captured).rejects.toBe(failure);
  },
);

it("does not assimilate a native Promise's already fulfilled payload again", async () => {
  let reads = 0;
  const payload = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "then") reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const fulfilled = Promise.resolve(payload);
  expect(reads).toBe(1);
  expect(() => batch((): unknown => fulfilled)).toThrow("Reactive batches must be synchronous");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(reads).toBe(1);
});

it("does not evaluate toStringTag getters while classifying synchronous results", () => {
  const tag = vi.fn<() => never>(() => {
    throw new Error("A presentation getter must not classify settlement");
  });
  const prototype = Object.create(null, { [Symbol.toStringTag]: { get: tag } });
  const value = Object.create(prototype, { [Symbol.toStringTag]: { get: tag } });
  expect(batch(() => value)).toBe(value);
  expect(tag).not.toHaveBeenCalled();
});

it("ignores an own presentation getter on a native Promise", () => {
  const tag = vi.fn<() => never>(() => {
    throw new Error("Native settlement does not depend on presentation");
  });
  const fulfilled = Promise.resolve();
  Object.defineProperty(fulfilled, Symbol.toStringTag, { get: tag });
  expect(() => batch((): unknown => fulfilled)).toThrow("Reactive batches must be synchronous");
  expect(tag).not.toHaveBeenCalled();
});

it("observes a Promise subclass through one species lookup", async () => {
  let reads = 0;
  class NativeResult extends Promise<unknown> {
    static override get [Symbol.species]() {
      reads++;
      return Promise;
    }
  }
  const fulfilled = new NativeResult((resolve) => resolve(undefined));
  expect(() => batch((): unknown => fulfilled)).toThrow("Reactive batches must be synchronous");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(reads).toBe(1);
});

it("rejects a forged native Promise prototype instead of treating it as a synchronous value", () => {
  const forged = Object.create(Promise.prototype);
  // oxlint-disable-next-line unicorn/no-thenable -- Masking inherited then makes the forged marker's behavior observable.
  Object.defineProperty(forged, "then", { value: undefined });
  expect(() => batch(() => forged)).toThrow(TypeError);
});

it("rejects a cyclic prototype reported by a Proxy without reading its public protocol", () => {
  const read = vi.fn<() => undefined>();
  const cyclic: object = new Proxy({}, { getPrototypeOf: () => cyclic, get: read });
  expect(() => batch(() => cyclic)).toThrow("Result has a cyclic prototype chain");
  expect(read).not.toHaveBeenCalled();
});

it.each(["constructor", "species"] as const)(
  "surfaces a native %s failure once instead of falling back to synchronous success",
  (property) => {
    const fulfilled = Promise.resolve();
    const failure = new Error(`${property} observation failed`);
    const read = vi.fn<() => never>(() => {
      throw failure;
    });
    // oxlint-disable-next-line unicorn/no-thenable -- A Proxy would lose the native brand required by this regression.
    Object.defineProperty(fulfilled, "then", { value: undefined });
    Object.defineProperty(
      fulfilled,
      "constructor",
      property === "constructor"
        ? { get: read }
        : { value: Object.create(null, { [Symbol.species]: { get: read } }) },
    );
    expect(() => assertSynchronous(fulfilled, "synchronous result required")).toThrow(failure);
    expect(read).toHaveBeenCalledOnce();
  },
);

it("observes rejected decorated native Promises without creating another unhandled rejection", () => {
  const source = new URL("../../../tooling/internal/async-result.ts", import.meta.url);
  const program = `
    import { assertSynchronous } from ${JSON.stringify(source.href)};
    const unhandled = [];
    process.on("unhandledRejection", (error) => unhandled.push(error));
    let rejected = 0;
    for (const throwing of [false, true]) {
      const pending = Promise.withResolvers();
      Object.defineProperty(pending.promise, "then", throwing
        ? { get() { throw new Error("public getter failure"); } }
        : { value: undefined });
      try { assertSynchronous(pending.promise, "synchronous result required"); }
      catch (error) { if (error instanceof TypeError) rejected++; else throw error; }
      pending.reject(new Error("original native rejection"));
    }
    await new Promise((resolve) => setImmediate(resolve));
    console.log(JSON.stringify({ rejected, unhandled: unhandled.length }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(JSON.parse(output)).toEqual({ rejected: 2, unhandled: 0 });
});
