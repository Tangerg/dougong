import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/index";

describe("SerialQueue", () => {
  it("accepts synchronous operations but refuses ambiguous input", async () => {
    const queue = new SerialQueue();

    expect(() => queue.run(undefined as never)).toThrowError(
      new TypeError("SerialQueue operation must be a function"),
    );
    await expect(queue.run(() => 1)).resolves.toBe(1);
  });

  it("isolates caller results while continuing after a failed operation", async () => {
    const queue = new SerialQueue();
    const trace: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("first failed");

    const first = queue.run(async () => {
      trace.push("first:start");
      await blocked;
      trace.push("first:end");
      throw failure;
    });
    const firstSettled = queue.settled;
    const second = queue.run(async () => {
      trace.push("second");
      return 2;
    });
    const settled = queue.settled;

    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);
    release();

    await expect(first).rejects.toBe(failure);
    await expect(firstSettled).resolves.toBeUndefined();
    await expect(second).resolves.toBe(2);
    await expect(settled).resolves.toBeUndefined();
    expect(trace).toEqual(["first:start", "first:end", "second"]);
  });
});
