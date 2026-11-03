import { expect, it, vi } from "vitest";
import { resolveValue } from "../src/advanced";

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
