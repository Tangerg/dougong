import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, event, type Disposable, type LifetimeContext } from "../src";

describe("Lifetime diagnostic projections", () => {
  it.each(["Installation", "Host"])(
    "keeps %s diagnostics readable while a disposed Instance is still stopping",
    async (source) => {
      const host = createHost();
      const installation = host.install(definePlugin({ name: "diagnostics.drained", setup() {} }));
      await host.start();
      const view = installation.diagnostics.get().lifetime!;
      const observed = Promise.withResolvers<unknown>();
      view.subscribe(() => {
        if (view.get().phase !== "disposed") return;
        queueMicrotask(() => {
          try {
            const snapshot =
              source === "Installation"
                ? installation.diagnostics.get()
                : host.diagnostics.get().installations.get(installation.id)!;
            observed.resolve({ status: snapshot.status, lifetime: snapshot.lifetime?.get().phase });
          } catch (error) {
            observed.resolve({ error });
          }
        });
      });

      await host.stop();
      expect(await observed.promise).toEqual({ status: "stopping", lifetime: "disposed" });
      expect(host.status).toBe("idle");
    },
  );

  it("reads direct resource membership and keeps historical counts immutable", async () => {
    const host = createHost();
    const notice = event<void>("diagnostics/direct-resources");
    let first!: Disposable;
    const installation = host.install(
      definePlugin({
        name: "diagnostics.direct-resources",
        setup(ctx) {
          first = ctx.on(notice, () => undefined);
          ctx.on(notice, () => undefined);
        },
      }),
    );
    await host.start();
    const view = installation.diagnostics.get().lifetime!;
    const before = view.get();
    expect(before.listeners).toBe(2);
    first.dispose();
    first.dispose();
    expect(view.get().listeners).toBe(1);
    expect(before.listeners).toBe(2);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.children)).toBe(true);
    expect(Object.keys(before).toSorted()).toEqual([
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
    await host.stop();
    expect(view.get().listeners).toBe(0);
  });

  it("projects each real child identity even when labels are equal", async () => {
    const host = createHost();
    const notice = event<void>("diagnostics/child-identities");
    let first!: LifetimeContext;
    const installation = host.install(
      definePlugin({
        name: "diagnostics.child-identities",
        setup(ctx) {
          first = ctx.lifetime("session");
          first.on(notice, () => undefined);
          ctx.lifetime("session");
        },
      }),
    );
    await host.start();
    const view = installation.diagnostics.get().lifetime!;
    expect(view.get().listeners).toBe(0);
    expect(view.get().children.map((child) => [child.label, child.listeners])).toEqual([
      ["session", 1],
      ["session", 0],
    ]);
    await first.dispose();
    const snapshot = view.get();
    await first.dispose();
    expect(view.get()).toBe(snapshot);
    expect(snapshot.children.map((child) => [child.label, child.listeners])).toEqual([
      ["session", 0],
    ]);
    await host.stop();
    expect(view.get().children).toEqual([]);
  });

  it("publishes terminal phase, reports observer failures and releases subscriptions", async () => {
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({ onError: report });
    const installation = host.install(definePlugin({ name: "diagnostics.terminal", setup() {} }));
    await host.start();
    const view = installation.diagnostics.get().lifetime!;
    const failure = new Error("terminal Lifetime observer");
    const listener = vi.fn<() => void>(() => {
      if (view.get().phase === "disposed") throw failure;
    });
    const subscription = view.subscribe(listener);
    await host.stop();
    expect(view.get()).toMatchObject({ phase: "disposed", children: [], cleanups: 0, tasks: 0 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(() => view.subscribe(() => undefined)).toThrow("Snapshot publisher is disposed");
    const terminal = view.get();
    await host.start();
    await host.stop();
    expect(view.get()).toBe(terminal);
    expect(listener).toHaveBeenCalledTimes(2);
    subscription.dispose();
  });
});
