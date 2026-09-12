import { expect, it } from "vitest";
import { batch, computed, signal } from "../src";

it("does not visit subscriptions created during the same publication", () => {
  const source = signal(0);
  let calls = 0;
  let subscription = source.subscribe(listener);
  function listener() {
    subscription.dispose();
    if (++calls < 4) subscription = source.subscribe(listener);
  }
  source.set(1);
  expect(calls).toBe(1);
  subscription.dispose();
});

it.each([false, true])(
  "drains nested writes without reentering a subscriber (batch=%s)",
  (batched) => {
    const a = signal(0);
    const b = signal(0);
    const trace: string[] = [];
    a.subscribe(() => {
      trace.push("a:enter");
      batch(() => b.set(a.get()));
      trace.push("a:leave");
    });
    b.subscribe(() => trace.push("b"));
    if (batched) batch(() => a.set(1));
    else a.set(1);
    expect(trace).toEqual(["a:enter", "a:leave", "b"]);
  },
);

it.each([false, true])("coalesces a diamond by downstream subscription (batch=%s)", (batched) => {
  const source = signal(1);
  const left = computed(() => source.get() * 2);
  const right = computed(() => source.get() * 3);
  const sum = computed(() => left.get() + right.get());
  const seen: number[] = [];
  sum.subscribe(() => seen.push(sum.get()));
  if (batched) batch(() => source.set(2));
  else source.set(2);
  expect(seen).toEqual([10]);
});

it("settles unequal dependency paths before notifying their shared observer", () => {
  const source = signal(1);
  const short = computed(() => source.get() * 2);
  const middle = computed(() => source.get() * 3);
  const long = computed(() => middle.get() * 2);
  const sum = computed(() => short.get() + long.get());
  const seen: number[] = [];
  sum.subscribe(() => seen.push(sum.get()));
  source.set(2);
  expect(seen).toEqual([16]);
});

it("keeps notifying after a computed calculation fails and switches dependencies", () => {
  const useRight = signal(false);
  const left = signal(1);
  const right = signal(-1);
  const selected = computed(() => {
    const value = useRight.get() ? right.get() : left.get();
    if (value < 0) throw new Error("negative value");
    return value;
  });
  const seen: number[] = [];
  using _subscription = selected.subscribe(() => seen.push(selected.get()));
  expect(() => useRight.set(true)).toThrow("negative value");
  right.set(2);
  expect(seen).toEqual([2]);
  left.set(3);
  expect(seen).toEqual([2]);
});

it("lets an unobserved computed handle a dependency's failure and recovery", () => {
  const input = signal(1);
  const value = computed(() => {
    if (input.get() < 0) throw undefined;
    return input.get();
  });
  const safe = computed(() => {
    try {
      return value.get();
    } catch {
      return "unavailable";
    }
  });
  expect(safe.get()).toBe(1);
  input.set(-1);
  expect(safe.get()).toBe("unavailable");
  input.set(2);
  expect(safe.get()).toBe(2);
});

it("rejects signal writes during calculation before they can invalidate the captured value", () => {
  const source = signal(0);
  const derived = computed(() => {
    const value = source.get();
    source.set(value + 1);
    return value;
  });
  expect(() => derived.get()).toThrow("Computed signal calculations cannot write signals");
  expect(source.get()).toBe(0);
});

it("can recover from a conditional cycle through previously cached computations", () => {
  const cyclic = signal(false);
  const left = computed((): number => (cyclic.get() ? right.get() : 1));
  const right = computed(() => left.get() + 1);
  expect(right.get()).toBe(2);
  cyclic.set(true);
  expect(() => right.get()).toThrow("Circular computed signal");
  cyclic.set(false);
  expect(right.get()).toBe(2);
});

it("preserves a caught failure as a stable value through an observed computed chain", () => {
  const value = signal(0);
  const failure = new Error("temporarily unavailable");
  const derived = computed(() => {
    if (value.get() < 0) throw failure;
    return value.get();
  });
  const safe = computed(() => {
    try {
      return derived.get();
    } catch {
      return "unavailable";
    }
  });
  const seen: Array<number | string> = [];
  using _subscription = safe.subscribe(() => seen.push(safe.get()));
  value.set(-1);
  value.set(-2);
  value.set(2);
  expect(seen).toEqual(["unavailable", "unavailable", 2]);
});
