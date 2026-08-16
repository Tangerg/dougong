import { describe, expect, it } from "vitest";
import { ActivationGate } from "../src/activation-gate";
import { ActivationBarrier } from "../src/activator";

describe("ActivationBarrier", () => {
  it("releases its owner exactly once", async () => {
    let releases = 0;
    const barrier = new ActivationBarrier(Promise.resolve(), () => {
      releases++;
    });

    await barrier.settled;
    barrier.release();
    barrier.release();

    expect(releases).toBe(1);
  });

  it("detaches before surfacing an owner release failure", () => {
    const failure = new Error("release failed");
    let releases = 0;
    const barrier = new ActivationBarrier(Promise.resolve(), () => {
      releases++;
      throw failure;
    });

    expect(() => barrier.release()).toThrow(failure);
    expect(() => barrier.release()).not.toThrow();
    expect(releases).toBe(1);
  });
});

describe("ActivationGate", () => {
  it("closes admission until every admitted tree releases its permit", async () => {
    const gate = new ActivationGate();
    const first = gate.enter();
    const second = gate.enter();
    if (!first || !second) throw new Error("Open gate did not issue permits");

    const settled = gate.close();
    expect(gate.enter()).toBeUndefined();
    expect(() => gate.close()).toThrowError(new Error("Activation gate is already closed"));
    expect(() => gate.open()).toThrowError(new Error("Activation gate still has active permits"));

    first.release();
    first.release();
    let completed = false;
    void settled.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    second.release();
    await settled;
    gate.open();
    expect(() => gate.open()).toThrowError(new Error("Activation gate is already open"));
  });

  it("settles immediately when no activation tree is admitted", async () => {
    const gate = new ActivationGate();
    await gate.close();
    gate.open();
    const permit = gate.enter();
    expect(permit).toBeDefined();
    permit?.release();
  });
});
