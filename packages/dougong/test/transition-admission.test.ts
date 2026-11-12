import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { createHost, createResourceAuthority, definePlugin, service } from "../src";

const resourceAuthority = createResourceAuthority();

function cancellationSignal(kind: "timeout" | "composite") {
  return kind === "timeout"
    ? AbortSignal.timeout(60_000)
    : AbortSignal.any([new AbortController().signal]);
}

function executionFixture() {
  const value = service<number>("transition-admission/value");
  const release = vi.fn<() => void>();
  const original = definePlugin({
    name: "original",
    provides: { value },
    setup({ lifetime }) {
      lifetime.defer(release);
      return { value: 1 };
    },
  });
  const replacement = definePlugin({
    name: "replacement",
    provides: { value },
    setup: () => ({ value: 2 }),
  });
  const host = createHost({
    resourceAuthority,
    installations: [{ id: "provider", plugin: original }],
  });
  return { host, value, replacement, release };
}

it.each(["timeout", "composite"] as const)(
  "rejects failed %s signal attachment before consuming the Plan or sealing execution",
  async (kind) => {
    const { host, value, replacement, release } = executionFixture();
    await host.start();
    const revision = host.stateRevision;
    const change = host.change();
    change.update(host.installation("provider")!, { plugin: replacement });
    const plan = await host.plan(change);
    const signal = cancellationSignal(kind);
    const failure = new Error("native cancellation attachment failed");
    let rejectAttachment = false;
    Object.defineProperty(signal, "aborted", {
      get() {
        if (rejectAttachment) throw failure;
        return Reflect.get(AbortSignal.prototype, "aborted", signal);
      },
    });
    try {
      const applying = host.apply(plan, signal);
      rejectAttachment = true;
      await expect(applying).rejects.toBe(failure);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      expect(host.status).toBe("running");
      expect(host.stateRevision).toBe(revision);
      expect(host.diagnostics.get().installations[0]?.lifetime?.phase).toBe("active");
      await expect(host.use(value, (current) => current)).resolves.toEqual({ value: 1 });
      expect(release).not.toHaveBeenCalled();
      await host.apply(plan);
      await expect(host.use(value, (current) => current)).resolves.toEqual({ value: 2 });
    } finally {
      await host.stop();
    }
  },
);

it.each(["timeout", "composite"] as const)(
  "checks idleness after a %s signal attachment reenters a foreground borrow",
  async (kind) => {
    const { host, value, replacement, release } = executionFixture();
    await host.start();
    const revision = host.stateRevision;
    const change = host.change();
    change.update(host.installation("provider")!, { plugin: replacement });
    const plan = await host.plan(change);
    const signal = cancellationSignal(kind);
    const finish = Promise.withResolvers<void>();
    const borrowedValues: number[] = [];
    let borrowOnAttachment = false;
    let borrowing: Promise<unknown> | undefined;
    Object.defineProperty(signal, "aborted", {
      get() {
        if (borrowOnAttachment) {
          borrowOnAttachment = false;
          borrowing = host.use(value, async (current) => {
            borrowedValues.push(current);
            await finish.promise;
          });
          void borrowing.catch(() => undefined);
        }
        return Reflect.get(AbortSignal.prototype, "aborted", signal);
      },
    });
    try {
      const applying = host.apply(plan, signal);
      borrowOnAttachment = true;
      await expect(applying).rejects.toMatchObject({ code: "HOST_BUSY" });
      expect(borrowedValues).toEqual([1]);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      expect(host.stateRevision).toBe(revision);
      expect(host.diagnostics.get().installations[0]?.lifetime?.phase).toBe("active");
      expect(release).not.toHaveBeenCalled();
      finish.resolve();
      await borrowing;
      await host.apply(plan);
      await expect(host.use(value, (current) => current)).resolves.toEqual({ value: 2 });
    } finally {
      finish.resolve();
      await borrowing?.catch(() => undefined);
      await host.stop();
    }
  },
);

it("rejects cancellation delivered during transition attachment before retiring the committed execution", async () => {
  const { host, value, replacement, release } = executionFixture();
  await host.start();
  const revision = host.stateRevision;
  const change = host.change();
  change.update(host.installation("provider")!, { plugin: replacement });
  const plan = await host.plan(change);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal]);
  const reason = new Error("cancelled while attaching transition");
  let cancelOnAttachment = false;
  Object.defineProperty(signal, "aborted", {
    get() {
      if (cancelOnAttachment) {
        cancelOnAttachment = false;
        controller.abort(reason);
      }
      return Reflect.get(AbortSignal.prototype, "aborted", signal);
    },
  });
  try {
    const applying = host.apply(plan, signal);
    cancelOnAttachment = true;
    await expect(applying).rejects.toBe(reason);
    expect(getEventListeners(signal, "abort")).toEqual([]);
    expect(host.stateRevision).toBe(revision);
    expect(host.diagnostics.get().installations[0]?.lifetime?.phase).toBe("active");
    expect(release).not.toHaveBeenCalled();
    await expect(host.use(value, (current) => current)).resolves.toEqual({ value: 1 });
    await host.apply(plan);
  } finally {
    await host.stop();
  }
});
