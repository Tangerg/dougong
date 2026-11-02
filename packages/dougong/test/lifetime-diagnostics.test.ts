import { describe, expect, it, vi } from "vitest";
import { Lifetime } from "../src/lifetime/lifetime";
import { EventHub } from "../src/events/event-hub";
import { createHost } from "../src/execution/host";
import { definePlugin } from "../src/composition/plugin";

const createLifetime = () => new Lifetime({ label: "diagnostic-owner", report: () => undefined });

describe("Lifetime diagnostic projections", () => {
  it("reads direct resource membership and keeps historical counts immutable", async () => {
    const lifetime = createLifetime();
    const events = new EventHub();
    const first = events.stage("notice", () => undefined, lifetime);
    events.stage("notice", () => undefined, lifetime);
    const interrupt = lifetime.interrupt(() => undefined);
    lifetime.publish();
    const before = lifetime.snapshot();
    expect(before.interrupts).toBe(1);
    interrupt[Symbol.dispose]();
    expect(lifetime.snapshot().interrupts).toBe(0);
    expect(before.interrupts).toBe(1);
    expect(before.publications).toBe(2);
    first[Symbol.dispose]();
    first[Symbol.dispose]();
    expect(lifetime.snapshot().publications).toBe(1);
    expect(before.publications).toBe(2);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.children)).toBe(true);
    expect(Object.isFrozen(before.unresolved)).toBe(true);
    await lifetime.dispose();
    expect(lifetime.snapshot()).toMatchObject({ phase: "disposed", publications: 0 });
  });

  it("projects each owned child even when descriptive labels are equal", async () => {
    const lifetime = createLifetime();
    const first = lifetime.child("session");
    first.defer(() => undefined);
    lifetime.child("session");
    expect(lifetime.snapshot().children.map((child) => [child.label, child.cleanups])).toEqual([
      ["session", 1],
      ["session", 0],
    ]);
    await first[Symbol.asyncDispose]();
    const snapshot = lifetime.snapshot();
    await first[Symbol.asyncDispose]();
    expect(lifetime.snapshot()).toEqual(snapshot);
    expect(snapshot.children.map((child) => [child.label, child.cleanups])).toEqual([
      ["session", 0],
    ]);
    await lifetime.dispose();
    expect(lifetime.snapshot().children).toEqual([]);
  });

  it("projects real nested ownership and pending cleanup obligations", async () => {
    const lifetime = createLifetime();
    const first = lifetime.child("session");
    const second = first.child("connection");
    second.defer(() => {
      throw new Error("connection not released");
    });
    const before = lifetime.snapshot();
    await expect(lifetime.dispose()).rejects.toBeInstanceOf(AggregateError);
    const after = lifetime.snapshot();
    expect(before.children[0]?.children[0]?.phase).toBe("active");
    expect(after.phase).toBe("quarantined");
    expect(after.children[0]?.children[0]).toMatchObject({
      phase: "quarantined",
      unresolved: [{ kind: "cleanup", error: { message: "connection not released" } }],
    });
  });

  it("publishes Host diagnostics from the authoritative runtime without invalidating saved values", async () => {
    const failure = new Error("observer failed");
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({
      onError: report,
      installations: [
        {
          id: "owned",
          plugin: definePlugin({
            name: "diagnostic",
            setup({ lifetime }) {
              lifetime.defer(() => undefined);
            },
          }),
        },
      ],
    });
    await host.start();
    const active = host.diagnostics.get();
    const subscription = host.diagnostics.subscribe(() => {
      if (host.status === "stopped") throw failure;
    });
    await host.stop();
    expect(host.diagnostics.get().status).toBe("stopped");
    expect(active.status).toBe("running");
    expect(active.installations[0]?.lifetime?.phase).toBe("active");
    expect(report).toHaveBeenCalledWith(failure);
    subscription[Symbol.dispose]();
  });
});

it("preserves the original child publication failure at its owner without a second withdrawal", async () => {
  const root = createLifetime();
  const child = root.resolveOwner({ lifetime: root.child("child") });
  const original = new Error("cannot withdraw");
  const withdraw = vi.fn<() => never>(() => {
    throw original;
  });
  child.stage((detach) => ({
    publish() {},
    [Symbol.dispose]() {
      detach();
      withdraw();
    },
  }));
  root.publish();
  const failure = await root.dispose().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0].errors[0]).toBe(original);
  expect(root.snapshot().children[0]).toMatchObject({
    phase: "quarantined",
    publications: 1,
    unresolved: [{ kind: "publication", error: { message: original.message } }],
  });
  expect(withdraw).toHaveBeenCalledOnce();
});

it("removes a finished child before publishing its terminal diagnostics", async () => {
  let close!: () => Promise<void>;
  const host = createHost({
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            close = lifetime.child("session")[Symbol.asyncDispose];
          },
        }),
      },
    ],
  });
  await host.start();
  try {
    const phases: Array<string | undefined> = [];
    using _subscription = host.diagnostics.subscribe(() => {
      phases.push(host.diagnostics.get().installations[0]?.lifetime?.children[0]?.phase);
    });
    await close();
    expect(phases).toEqual(["disposing", undefined]);
  } finally {
    await host.stop();
  }
});
