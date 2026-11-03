import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { batch, observe, signal, type ObservationOwner } from "../src";
import { captureThenable } from "../src/async-result";

class TaggedPromise<T> implements Promise<T> {
  declare readonly [Symbol.toStringTag]: string;
  readonly #promise: Promise<T>;
  thenCalls = 0;

  constructor(promise: Promise<T>) {
    this.#promise = promise;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- A conforming structural Promise must expose its own fulfillment protocol.
  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.thenCalls++;
    return this.#promise.then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#promise.catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onFinally);
  }
}

Object.defineProperty(TaggedPromise.prototype, Symbol.toStringTag, { value: "Promise" });

it("accepts a structural Promise without treating its display tag as native authority", async () => {
  const pending = Promise.withResolvers<number>();
  const tagged = new TaggedPromise(pending.promise);
  const captured = captureThenable(tagged)!;
  expect(tagged.thenCalls).toBe(0);
  pending.resolve(42);
  await expect(captured).resolves.toEqual({ value: 42 });
  expect(tagged.thenCalls).toBe(1);
});

it("rejects tagged asynchronous batch results through the synchronous contract", async () => {
  const tagged = new TaggedPromise(Promise.resolve());
  expect(() => batch(() => tagged)).toThrow("Reactive batches must be synchronous");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(tagged.thenCalls).toBe(1);
});

it("composes observation with a tagged structural Task result", async () => {
  let releases = 0;
  const owner: ObservationOwner = {
    defer(dispose) {
      return {
        async [Symbol.asyncDispose]() {
          await dispose();
        },
      };
    },
    child() {
      return {
        async [Symbol.asyncDispose]() {
          releases++;
        },
      };
    },
    spawn(task) {
      const controller = new AbortController();
      const result = Promise.resolve().then(() => task(controller.signal));
      return {
        result: new TaggedPromise(result),
        async [Symbol.asyncDispose]() {
          controller.abort();
          await result;
        },
      };
    },
  };
  const source = signal(1);
  const seen: number[] = [];
  const observation = observe(owner, source, (value) => seen.push(value));
  try {
    source.set(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([1, 2]);
    expect(releases).toBe(1);
  } finally {
    await observation[Symbol.asyncDispose]();
  }
  expect(releases).toBe(2);
});

it("observes the real structural rejection after rejecting tagged asynchronous misuse", () => {
  const source = new URL("../../../tooling/internal/async-result.ts", import.meta.url);
  const program = `
    import { assertSynchronous } from ${JSON.stringify(source.href)};
    const pending = Promise.withResolvers();
    const unhandled = [];
    process.on("unhandledRejection", (error) => unhandled.push(error));
    let thenCalls = 0;
    const prototype = { [Symbol.toStringTag]: "Promise" };
    const result = Object.create(prototype, {
      then: { value(resolve, reject) {
        thenCalls++;
        return pending.promise.then(resolve, reject);
      } },
    });
    let rejected = false;
    try { assertSynchronous(result, "synchronous result required"); }
    catch (error) { rejected = error instanceof TypeError && error.message === "synchronous result required"; }
    pending.reject(new Error("original structural rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    console.log(JSON.stringify({ rejected, thenCalls, unhandled: unhandled.length }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(JSON.parse(output)).toEqual({ rejected: true, thenCalls: 1, unhandled: 0 });
});
