import { describe, expect, it, vi } from "vitest";
import { batch, computed, signal } from "../src/index";

describe("signal", () => {
  it("stores values and only notifies changes", () => {
    const count = signal(0);
    const listener = vi.fn<() => void>();
    const subscription = count.subscribe(listener);

    count.set(0);
    count.set(1);
    count.set(1);

    expect(count.get()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.dispose();
    count.set(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("batches notifications through one subscriber path", () => {
    const left = signal(1);
    const right = signal(2);
    const listener = vi.fn<() => void>();

    left.subscribe(listener);
    right.subscribe(listener);

    batch(() => {
      left.set(3);
      right.set(4);
      left.set(5);
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every subscriber before surfacing their failures", () => {
    const value = signal(0);
    const second = vi.fn<() => void>();
    value.subscribe(() => {
      throw new Error("first failed");
    });
    value.subscribe(second);

    expect(() => value.set(1)).toThrow("first failed");
    expect(second).toHaveBeenCalledOnce();
  });

  it("preserves thrown undefined across a batch boundary", () => {
    let thrown = false;
    try {
      batch(() => {
        throw undefined;
      });
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(true);
  });
});

describe("computed", () => {
  it("tracks dynamic dependencies", () => {
    const enabled = signal(true);
    const left = signal(1);
    const right = signal(2);
    const selected = computed(() => (enabled.get() ? left.get() : right.get()));
    const listener = vi.fn<() => void>();

    expect(selected.get()).toBe(1);
    const subscription = selected.subscribe(listener);

    left.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected.get()).toBe(3);

    enabled.set(false);
    expect(selected.get()).toBe(2);

    listener.mockClear();
    left.set(4);
    expect(listener).not.toHaveBeenCalled();

    right.set(5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected.get()).toBe(5);

    subscription.dispose();
  });

  it("is lazy and cached while it has no subscribers", () => {
    const value = signal(1);
    const calculate = vi.fn<() => number>(() => value.get() * 2);
    const doubled = computed(calculate);

    expect(calculate).not.toHaveBeenCalled();
    expect(doubled.get()).toBe(2);
    expect(doubled.get()).toBe(2);
    expect(calculate).toHaveBeenCalledTimes(1);

    value.set(2);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(doubled.get()).toBe(4);
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it("validates nested computed signals lazily", () => {
    const value = signal(1);
    const doubled = computed(() => value.get() * 2);
    const formatted = computed(() => `value:${doubled.get()}`);

    expect(formatted.get()).toBe("value:2");
    value.set(3);
    expect(formatted.get()).toBe("value:6");
  });

  it("does not retain a subscriber when initial evaluation fails", () => {
    const calculate = vi.fn<() => number>(() => {
      throw new Error("cannot calculate");
    });
    const broken = computed(calculate);

    expect(() => broken.subscribe(() => {})).toThrow("cannot calculate");
    expect(() => broken.subscribe(() => {})).toThrow("cannot calculate");
    expect(calculate).toHaveBeenCalledTimes(2);
  });
});
