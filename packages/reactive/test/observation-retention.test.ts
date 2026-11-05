import { expect, it, vi } from "vitest";
import { observe, signal, type ObservationOwner, type Readable } from "../src";

it.each(["missing release", "release getter failure", "registration failure"] as const)(
  "detaches a rejected observation when its owner reports %s",
  async (failure) => {
    let registeredCleanup!: () => unknown;
    const subscribe = vi.fn<Readable<number>["subscribe"]>();
    const child = vi.fn<ObservationOwner["child"]>();
    const spawn = vi.fn<ObservationOwner["spawn"]>();

    function rejectObservation() {
      const source: Readable<number> = { get: () => 1, subscribe };
      const observer = () => {};
      const owner: ObservationOwner = {
        defer(cleanup) {
          registeredCleanup = cleanup;
          if (failure === "registration failure") throw new Error(failure);
          if (failure === "missing release") return {} as never;
          return {
            get [Symbol.asyncDispose](): () => Promise<void> {
              throw new Error(failure);
            },
          };
        },
        child,
        spawn,
      };
      expect(() => observe(owner, source, observer)).toThrow(
        failure === "missing release"
          ? "ObservationOwner.defer() must return an AsyncDisposable"
          : failure,
      );
      return [new WeakRef(source), new WeakRef(observer), new WeakRef(owner)];
    }

    const references = rejectObservation();
    expect(subscribe).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      globalThis.gc!();
    }
    expect(references.map((reference) => reference.deref())).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await registeredCleanup();
  },
);

it("releases the owner after successful observation shutdown while its cleanup and handle remain reachable", async () => {
  let registeredCleanup!: () => unknown;
  const observed: number[] = [];
  let releasedChildren = 0;

  async function closeObservation() {
    const source = signal(1);
    const observer = (value: number) => observed.push(value);
    const context = { source, observer };
    const owner: ObservationOwner & { readonly context: typeof context } = {
      context,
      defer(cleanup) {
        registeredCleanup = cleanup;
        return {
          async [Symbol.asyncDispose]() {
            await cleanup();
          },
        };
      },
      child() {
        return {
          async [Symbol.asyncDispose]() {
            releasedChildren++;
          },
        };
      },
      spawn(task) {
        const controller = new AbortController();
        const result = Promise.resolve().then(() => task(controller.signal));
        return {
          result,
          async [Symbol.asyncDispose]() {
            controller.abort();
            await result;
          },
        };
      },
    };
    const handle = observe(owner, source, observer);
    await handle[Symbol.asyncDispose]();
    return {
      handle,
      references: [new WeakRef(source), new WeakRef(observer), new WeakRef(owner)],
    };
  }

  const { handle, references } = await closeObservation();
  expect(observed).toEqual([1]);
  expect(releasedChildren).toBe(1);
  for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc!();
  }
  expect(references.map((reference) => reference.deref())).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  await registeredCleanup();
  await handle[Symbol.asyncDispose]();
  expect(releasedChildren).toBe(1);
});
