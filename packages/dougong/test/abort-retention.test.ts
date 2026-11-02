import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { onAbort } from "../src/advanced";

const COLLECTION_PASSES = 16;
const SOURCE_KINDS = ["controller", "composite"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

async function collect() {
  const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
  for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
    await setImmediate();
    collectGarbage();
    collectGarbage();
    await setImmediate();
  }
}

function captureDependents<T>(register: () => T) {
  const nativeAny = AbortSignal.any;
  const dependents: WeakRef<AbortSignal>[] = [];
  // Spy call histories would themselves retain the source under inspection.
  AbortSignal.any = (signals) => {
    const dependent = nativeAny.call(AbortSignal, signals);
    dependents.push(new WeakRef(dependent));
    return dependent;
  };
  try {
    return { value: register(), dependents };
  } finally {
    AbortSignal.any = nativeAny;
  }
}

function subscription(source: AbortSignal) {
  const payload = { calls: 0 };
  const reasons: unknown[] = [];
  const callback = (reason: unknown) => {
    payload.calls++;
    reasons.push(reason);
  };
  const { value: unsubscribe, dependents } = captureDependents(() => onAbort(source, callback));
  return {
    unsubscribe,
    reasons,
    references: {
      source: new WeakRef(source),
      callback: new WeakRef(callback),
      payload: new WeakRef(payload),
      dependents,
    },
  };
}

function controllerSubscription(kind: SourceKind) {
  const controller = new AbortController();
  const source = kind === "composite" ? AbortSignal.any([controller.signal]) : controller.signal;
  return { controller, ...subscription(source) };
}

function abandonedSubscription(kind: SourceKind) {
  return controllerSubscription(kind).references;
}

function retainedUnsubscribe(kind: SourceKind) {
  const { unsubscribe, references, reasons } = controllerSubscription(kind);
  return { unsubscribe, references, reasons };
}

function retainedSource(kind: SourceKind) {
  const { controller, references, reasons } = controllerSubscription(kind);
  return { controller, references, reasons };
}

function activeSubscription(source: AbortSignal) {
  const { references, reasons } = subscription(source);
  return { references, reasons };
}

function expectObservationReleased(references: ReturnType<typeof subscription>["references"]) {
  expect.soft(references.callback.deref()).toBeUndefined();
  expect.soft(references.payload.deref()).toBeUndefined();
  for (const dependent of references.dependents) expect.soft(dependent.deref()).toBeUndefined();
}

describe("abort observation retention", () => {
  it.each(SOURCE_KINDS)(
    "collects abandoned %s observations and their native dependents",
    async (kind) => {
      const references = abandonedSubscription(kind);
      await collect();
      expect.soft(references.source.deref()).toBeUndefined();
      expectObservationReleased(references);
    },
  );

  it.each(SOURCE_KINDS)(
    "retains a %s observation only until its retained handle detaches",
    async (kind) => {
      const fixture = retainedUnsubscribe(kind);
      await collect();
      expect(fixture.references.source.deref() !== undefined).toBe(true);
      expect(fixture.references.callback.deref() !== undefined).toBe(true);
      expect(fixture.references.payload.deref()?.calls).toBe(0);
      fixture.unsubscribe();
      fixture.unsubscribe();
      await collect();
      expect.soft(fixture.references.source.deref()).toBeUndefined();
      expectObservationReleased(fixture.references);
      expect(typeof fixture.unsubscribe).toBe("function");
      expect(fixture.reasons).toEqual([]);
    },
  );

  it.each(SOURCE_KINDS)(
    "retains a %s callback while its upstream controller remains active",
    async (kind) => {
      const fixture = retainedSource(kind);
      await collect();
      expect(fixture.references.payload.deref()?.calls).toBe(0);
      const reason = { requested: true };
      fixture.controller.abort(reason);
      fixture.controller.abort();
      expect(fixture.reasons).toEqual([reason]);
      await collect();
      expectObservationReleased(fixture.references);
      expect(fixture.controller.signal.reason).toBe(reason);
    },
  );

  it("detaches one observation without releasing another callback owned by the same source", async () => {
    const controller = new AbortController();
    const removed = subscription(controller.signal);
    const active = activeSubscription(controller.signal);
    removed.unsubscribe();
    await collect();
    expectObservationReleased(removed.references);
    expect(active.references.payload.deref()?.calls).toBe(0);
    const reason = { requested: true };
    controller.abort(reason);
    expect(removed.reasons).toEqual([]);
    expect(active.reasons).toEqual([reason]);
    await collect();
    expectObservationReleased(active.references);
  });
});
