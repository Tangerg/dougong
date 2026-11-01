import { expect, it } from "vitest";
import { batch, computed, signal, type ReadonlySignal } from "../src";

it("does not visit subscriptions created during the same publication", () => {
  const source = signal(0);
  let calls = 0;
  let subscription = source.subscribe(listener);
  function listener() {
    subscription[Symbol.dispose]();
    if (++calls < 4) subscription = source.subscribe(listener);
  }
  source.set(1);
  expect(calls).toBe(1);
  subscription[Symbol.dispose]();
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

it("runs computed calculations as standalone callbacks without exposing their mutable node", () => {
  let receiver: unknown = null;
  const input = signal(0);
  const derived = computed(function (this: unknown) {
    receiver = this;
    return input.get();
  });
  expect(derived.get()).toBe(0);
  expect(receiver).toBeUndefined();
});

it.each(["batch", "observer"] as const)(
  "does not replay a preceding write to a newly subscribed computed inside a %s",
  (boundary) => {
    const source = signal(0);
    const derived = computed(() => source.get() + 1);
    const first: number[] = [],
      second: number[] = [];
    using _first = derived.subscribe(() => first.push(derived.get()));
    let late!: Disposable;
    const writeThenSubscribe = () => {
      source.set(1);
      late = derived.subscribe(() => second.push(derived.get()));
    };
    if (boundary === "batch") batch(writeThenSubscribe);
    else {
      const trigger = signal(0);
      using _trigger = trigger.subscribe(writeThenSubscribe);
      trigger.set(1);
    }
    try {
      expect(first).toEqual([2]);
      expect(second).toEqual([]);
      source.set(2);
      expect(first).toEqual([2, 3]);
      expect(second).toEqual([3]);
    } finally {
      late[Symbol.dispose]();
    }
  },
);

it("rejects a failed computed's public subscription even while an indirect subscriber is observing recovery", () => {
  const input = signal(false);
  const unavailable = new Error("unavailable");
  const sometimes = computed(() => {
    if (!input.get()) throw unavailable;
    return 1;
  });
  const safe = computed(() => {
    try {
      return sometimes.get();
    } catch {
      return 0;
    }
  });
  using _subscription = safe.subscribe(() => safe.get());
  let unexpected = 0;
  expect(() => sometimes.subscribe(() => unexpected++)).toThrow(unavailable);
  input.set(true);
  expect(safe.get()).toBe(1);
  expect(unexpected).toBe(0);
});

it("validates shared branches once per source write while preserving lazy values and errors", () => {
  const input = signal(1);
  const unrelated = signal(0);
  let reads = 0;
  let tip: ReadonlySignal<number> = computed(() => {
    reads++;
    const value = input.get();
    if (value < 0) throw new Error("negative input");
    return value;
  });
  // Twenty-four diamonds have only 73 derived nodes but millions of paths to the input.
  for (let level = 0; level < 24; level++) {
    const previous = tip;
    const a = computed(() => previous.get());
    const b = computed(() => previous.get());
    tip = computed(() => a.get() + b.get());
  }
  expect(tip.get()).toBe(2 ** 24);
  unrelated.set(1);
  expect(tip.get()).toBe(2 ** 24);
  expect(reads).toBe(1);
  input.set(-1);
  expect(() => tip.get()).toThrow("negative input");
  input.set(2);
  expect(tip.get()).toBe(2 ** 25);
  expect(reads).toBe(3);
});
