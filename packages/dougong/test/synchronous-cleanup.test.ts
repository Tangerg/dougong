import { describe, expect, it, vi } from "vitest";
import { createResourceAuthority, type Disposable } from "../src";
import { captureResourceAuthority, type Resource } from "../src/contracts/resource";
import { Lifetime, type Cleanup, type ReleaseFailure } from "../src/lifetime/lifetime";

function fixture() {
  const authority = createResourceAuthority();
  const claim = vi.fn<(resource: Resource) => () => void>((resource) => authority.claim(resource));
  const releaseFailed = vi.fn<(failure: ReleaseFailure) => void>();
  const controls: Disposable[] = [];
  let marking: ((handle: Disposable) => void) | undefined;
  const owner = new Lifetime({
    label: "synchronous-cleanup-owner",
    report() {},
    releaseFailed,
    resourceAuthority: captureResourceAuthority({
      claim,
      markControlHandle(handle: object) {
        authority.markControlHandle(handle);
        const control = handle as Disposable;
        controls.push(control);
        marking?.(control);
      },
    }),
  });
  return {
    owner,
    authority,
    claim,
    controls,
    releaseFailed,
    onMark: (callback: typeof marking) => (marking = callback),
  };
}

function disposalFailure(handle: Disposable): unknown {
  try {
    handle[Symbol.dispose]();
  } catch (error) {
    return error;
  }
  throw new Error("Expected synchronous disposal to fail");
}

it.each(["early disposal", "shutdown"] as const)(
  "releases one synchronous cleanup through %s without an external resource claim",
  async (trigger) => {
    const { owner, authority, claim } = fixture();
    const release = vi.fn<() => void>();
    const handle = owner.registerSynchronousCleanup(() => release);
    expect(owner.snapshot().cleanups).toBe(1);
    expect(() => authority.claim(handle)).toThrow("Owned control handles cannot be adopted");
    if (trigger === "early disposal") {
      handle[Symbol.dispose]();
    }
    expect(release).toHaveBeenCalledTimes(trigger === "early disposal" ? 1 : 0);
    expect(owner.snapshot().cleanups).toBe(trigger === "early disposal" ? 0 : 1);
    await owner.dispose();
    handle[Symbol.dispose]();
    expect(release).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({ phase: "disposed", cleanups: 0 });
    expect(claim).not.toHaveBeenCalled();
  },
);

describe.each(["early disposal", "shutdown"] as const)("failure during %s", (trigger) => {
  it.each(["Error", "undefined"] as const)(
    "retains a synchronous cleanup's failed %s outcome for every caller",
    async (kind) => {
      const { owner, releaseFailed } = fixture();
      const failure = kind === "undefined" ? undefined : new Error("synchronous cleanup failed");
      const release = vi.fn<Cleanup>(() => {
        throw failure;
      });
      const handle = owner.registerSynchronousCleanup(() => release);
      if (trigger === "shutdown") await owner.dispose().catch(() => undefined);
      expect(disposalFailure(handle)).toBe(failure);
      expect(disposalFailure(handle)).toBe(failure);
      expect(release).toHaveBeenCalledOnce();
      expect(releaseFailed).toHaveBeenCalledExactlyOnceWith({
        owner,
        kind: "cleanup",
        error: failure,
      });
      expect(owner.snapshot().cleanups).toBe(1);
      await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
      expect(disposalFailure(handle)).toBe(failure);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});

it("rejects an asynchronous cleanup result and retains that protocol failure", async () => {
  const { owner, releaseFailed } = fixture();
  const release = vi.fn<Cleanup>(() => Promise.reject(new Error("late cleanup failure")));
  const handle = owner.registerSynchronousCleanup(() => release);
  const failure = disposalFailure(handle);
  expect(failure).toBeInstanceOf(TypeError);
  expect(failure).toMatchObject({ message: "Synchronous cleanup must not return a Promise" });
  expect(disposalFailure(handle)).toBe(failure);
  await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
  expect(disposalFailure(handle)).toBe(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(releaseFailed).toHaveBeenCalledOnce();
});

it.each(["release notification", "diagnostic capture"] as const)(
  "publishes the failed outcome before %s can reenter the control handle",
  async (phase) => {
    const { owner, releaseFailed } = fixture();
    const observations: Array<{ failed: boolean; error: unknown }> = [];
    let handle!: Disposable;
    const failure = Object.defineProperty(new Error(), "stack", { value: "cleanup failure" });
    Object.defineProperty(failure, "message", {
      get() {
        let failed = false;
        let error: unknown;
        try {
          handle[Symbol.dispose]();
        } catch (reason) {
          failed = true;
          error = reason;
        }
        observations.push({ failed, error });
        return "cleanup release failed";
      },
    });
    if (phase === "release notification") {
      releaseFailed.mockImplementation(({ error }) => {
        void (error as Error).message;
      });
    }
    const release = vi.fn<() => void>(() => {
      throw failure;
    });
    handle = owner.registerSynchronousCleanup(() => release);
    try {
      expect(disposalFailure(handle)).toBe(failure);
      expect(observations.length).toBeGreaterThan(0);
      for (const observation of observations) {
        expect(observation.failed).toBe(true);
        expect(observation.error).toBe(failure);
      }
    } finally {
      await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
    }
    expect(release).toHaveBeenCalledOnce();
  },
);

it("owns the synchronous cleanup before control registration can release it", async () => {
  const { owner, onMark } = fixture();
  const release = vi.fn<() => void>();
  onMark((handle) => handle[Symbol.dispose]());
  const handle = owner.registerSynchronousCleanup(() => release);
  expect(release).toHaveBeenCalledOnce();
  expect(owner.snapshot().cleanups).toBe(0);
  handle[Symbol.dispose]();
  await owner.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it("keeps the original cleanup failure when registration reenters its failing release", async () => {
  const { owner, onMark, controls, releaseFailed } = fixture();
  const failure = new Error("reentrant cleanup failed");
  const release = vi.fn<() => void>(() => {
    throw failure;
  });
  onMark((handle) => handle[Symbol.dispose]());
  expect(() => owner.registerSynchronousCleanup(() => release)).toThrow(failure);
  expect(disposalFailure(controls[0]!)).toBe(failure);
  await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
  expect(releaseFailed).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it.each(["registration", "rollback"] as const)(
  "preserves both failures when cleanup fails during %s",
  async (phase) => {
    const { owner, onMark, controls } = fixture();
    const registrationFailure = new Error("control registration failed");
    const cleanupFailure = new Error("registration rollback failed");
    const release = vi.fn<() => void>(() => {
      throw cleanupFailure;
    });
    onMark((handle) => {
      if (phase === "registration") disposalFailure(handle);
      throw registrationFailure;
    });
    expect(() => owner.registerSynchronousCleanup(() => release)).toThrow(
      expect.objectContaining({ errors: [registrationFailure, cleanupFailure] }),
    );
    expect(disposalFailure(controls[0]!)).toBe(cleanupFailure);
    await expect(owner.dispose()).rejects.toMatchObject({ errors: [cleanupFailure] });
    expect(release).toHaveBeenCalledOnce();
  },
);

it("rejects a closed owner before acquiring any retained reference", async () => {
  const { owner, claim, controls } = fixture();
  const acquire = vi.fn<() => Cleanup>(() => () => undefined);
  await owner.dispose();
  expect(() => owner.registerSynchronousCleanup(acquire)).toThrow("closed to new work");
  expect(acquire).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(controls).toEqual([]);
});
