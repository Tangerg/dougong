import { describe, expect, it, vi } from "vitest";
import { LifetimeDiagnostics } from "../src/lifetime-diagnostics";

// These are internal invariant guards, tested directly because that is the only
// place they can be reached: every public path into them is already correct by
// construction. They exist so that a broken ownership edge inside Core is loud
// rather than silently absorbed, and this file is what stops a future change
// from "fixing" them into a clamp.

describe("Lifetime diagnostics invariants", () => {
  it("refuses a negative resource count instead of clamping it to zero", () => {
    const diagnostics = new LifetimeDiagnostics("install:1", () => undefined);

    diagnostics.change(diagnostics.root, "tasks", 1);
    diagnostics.change(diagnostics.root, "tasks", -1);

    // A second release for one acquisition means a resource was released twice,
    // or released by something that never owned it. Clamping would hide the bug
    // and leave the tree quietly describing the wrong ownership.
    expect(() => diagnostics.change(diagnostics.root, "tasks", -1)).toThrowError(
      new Error("Lifetime 'tasks' count cannot be negative"),
    );
    expect(diagnostics.view.get().tasks).toBe(0);
  });

  it("refuses to attach one node twice", () => {
    const diagnostics = new LifetimeDiagnostics("install:1", () => undefined);
    const child = diagnostics.createNode("session");
    diagnostics.attach(diagnostics.root, child);

    expect(() => diagnostics.attach(diagnostics.root, child)).toThrowError(
      new Error("Lifetime diagnostic node is attached"),
    );
    expect(diagnostics.view.get().children).toHaveLength(1);
  });

  it("ignores detaching a node that is not a child", () => {
    const diagnostics = new LifetimeDiagnostics("install:1", () => undefined);
    const listener = vi.fn<() => void>();
    using subscription = diagnostics.view.subscribe(listener);
    void subscription;

    diagnostics.detach(diagnostics.root, diagnostics.createNode("stranger"));

    // No invalidation, because nothing changed. A detach that notified anyway
    // would wake every observer to hand them an identical tree.
    expect(listener).not.toHaveBeenCalled();
  });

  it("counts resources without retaining them", () => {
    const diagnostics = new LifetimeDiagnostics("install:1", () => undefined);

    diagnostics.change(diagnostics.root, "listeners", 1);
    diagnostics.change(diagnostics.root, "contributions", 1);

    const snapshot = diagnostics.view.get();
    expect(snapshot).toMatchObject({
      label: "install:1",
      phase: "active",
      listeners: 1,
      contributions: 1,
      tasks: 0,
    });
    // Counts and a label, never the resources themselves: a diagnostics tree
    // that held the listeners it describes would keep them alive precisely
    // because someone was watching.
    expect(Object.keys(snapshot).toSorted()).toEqual([
      "children",
      "cleanups",
      "contributionViews",
      "contributions",
      "label",
      "listeners",
      "phase",
      "subscriptions",
      "tasks",
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("publishes disposal once and then stops accepting writes", () => {
    const diagnostics = new LifetimeDiagnostics("install:1", () => undefined);
    const listener = vi.fn<() => void>();
    diagnostics.view.subscribe(listener);

    diagnostics.beginDisposing(diagnostics.root);
    diagnostics.beginDisposing(diagnostics.root);
    expect(diagnostics.view.get().phase).toBe("disposing");
    expect(listener).toHaveBeenCalledOnce();

    diagnostics.finishRoot();
    diagnostics.finishRoot();

    expect(diagnostics.view.get().phase).toBe("disposed");
    expect(listener).toHaveBeenCalledTimes(2);
    // The publisher is disposed with the root, so the terminal snapshot stays
    // readable while further writes are refused.
    expect(() => diagnostics.change(diagnostics.root, "tasks", 1)).toThrow(
      "Snapshot publisher is disposed",
    );
  });
});
