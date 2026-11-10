import { expect, it, vi } from "vitest";
import {
  createHost,
  createResourceAuthority,
  definePlugin,
  type LifetimeContext,
  type Resource,
  type ResourceAuthority,
} from "../src";
import { captureResourceAuthority } from "../src/contracts/resource";
import { Lifetime } from "../src/lifetime/lifetime";

it.each([
  undefined,
  null,
  false,
  "domain",
  {},
  { claim() {} },
  { markControlHandle() {} },
  { claim: 1, markControlHandle() {} },
  { claim() {}, markControlHandle: 1 },
])("requires an explicit ResourceAuthority protocol at Host creation: %j", (resourceAuthority) => {
  expect(() => createHost({ resourceAuthority: resourceAuthority as never })).toThrow(
    "ResourceAuthority must implement claim and markControlHandle",
  );
});

it("captures an authority's methods and receiver once at the Host boundary", async () => {
  const resourceAuthority = createResourceAuthority();
  const reads = { claim: 0, control: 0 };
  let readable = true;
  const supplied = {
    get claim() {
      reads.claim++;
      if (!readable) throw new Error("claim was read again");
      return function (this: unknown, resource: Resource) {
        expect(this).toBe(supplied);
        return resourceAuthority.claim(resource);
      };
    },
    get markControlHandle() {
      reads.control++;
      if (!readable) throw new Error("markControlHandle was read again");
      return function (this: unknown, handle: object) {
        expect(this).toBe(supplied);
        resourceAuthority.markControlHandle(handle);
      };
    },
  };
  let lifetime!: LifetimeContext;
  const host = createHost({
    resourceAuthority: supplied,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            lifetime = context.lifetime;
          },
        }),
      },
    ],
  });
  readable = false;
  const release = vi.fn<() => void>();
  await host.start();
  try {
    lifetime.child("child").use({ [Symbol.dispose]: release });
  } finally {
    await host.stop();
  }
  expect(reads).toEqual({ claim: 1, control: 1 });
  expect(release).toHaveBeenCalledOnce();
});

it("keeps explicitly separate resource domains independent without an ambient registry", () => {
  const first = createResourceAuthority();
  const second = createResourceAuthority();
  const resource = { [Symbol.dispose]() {} };
  const releaseFirst = first.claim(resource);
  const releaseSecond = second.claim(resource);
  expect(() => first.claim(resource)).toThrow("Resource already has a Lifetime owner");
  releaseFirst();
  expect(() => second.claim(resource)).toThrow("Resource already has a Lifetime owner");
  releaseSecond();
});

it("rejects malformed claim receipts at their protocol boundary", () => {
  const authority = captureResourceAuthority({ claim: () => undefined, markControlHandle() {} });
  expect(() => authority.claim({ [Symbol.dispose]() {} })).toThrow(
    "ResourceAuthority.claim must return a release function",
  );
});

it("rejects asynchronous authority transitions without leaving their rejection unobserved", async () => {
  const failure = new Error("asynchronous authority transition");
  const resource = { [Symbol.dispose]() {} };
  const asynchronousClaim = captureResourceAuthority({
    claim: () => Promise.reject(failure),
    markControlHandle() {},
  });
  const asynchronousRelease = captureResourceAuthority({
    claim: () => () => Promise.reject(failure),
    markControlHandle() {},
  });
  const asynchronousControl = captureResourceAuthority({
    claim: () => () => undefined,
    markControlHandle: () => Promise.reject(failure),
  });
  expect(() => asynchronousClaim.claim(resource)).toThrow(
    "ResourceAuthority.claim must be synchronous",
  );
  expect(() => asynchronousRelease.claim(resource)()).toThrow(
    "ResourceAuthority claim release must be synchronous",
  );
  expect(() => asynchronousControl.markControlHandle(resource)).toThrow(
    "ResourceAuthority.markControlHandle must be synchronous",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it.each([
  { mode: "throw", message: "claim release failed" },
  { mode: "async", message: "ResourceAuthority claim release must be synchronous" },
])(
  "retains a failed $mode claim release without repeating the disposer",
  async ({ mode, message }) => {
    const authority = createResourceAuthority();
    const failure = new Error("claim release failed");
    const dispose = vi.fn<() => void>();
    const resource = { [Symbol.dispose]: dispose };
    const releaseClaim = vi.fn<() => void | Promise<never>>(() => {
      if (mode === "async") return Promise.reject(failure);
      throw failure;
    });
    const owner = createOwner(
      {
        claim(value) {
          const release = authority.claim(value);
          return value === resource ? releaseClaim : release;
        },
        markControlHandle(handle) {
          authority.markControlHandle(handle);
        },
      },
      (lifetime) => lifetime.use(resource),
    );
    await owner.host.start();
    await expect(owner.host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(owner.host.diagnostics.get().unresolved[0]?.lifetime.unresolved).toEqual([
      expect.objectContaining({ kind: "cleanup", error: expect.objectContaining({ message }) }),
    ]);
    expect(() => authority.claim(resource)).toThrow("Resource already has a Lifetime owner");
    await expect(owner.host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(releaseClaim).toHaveBeenCalledOnce();
  },
);

it("retains a failed claim release during forgetting without calling the disposer", async () => {
  const authority = createResourceAuthority();
  const failure = new Error("forgetting claim failed");
  const releaseClaim = vi.fn<() => void>(() => {
    throw failure;
  });
  const releaseFailed = vi.fn<() => void>();
  const owner = new Lifetime({
    label: "claim-owner",
    report() {},
    releaseFailed,
    resourceAuthority: captureResourceAuthority({
      claim(resource: Resource) {
        authority.claim(resource);
        return releaseClaim;
      },
      markControlHandle(handle: object) {
        authority.markControlHandle(handle);
      },
    }),
  });
  const dispose = vi.fn<() => void>();
  const resource = { [Symbol.dispose]: dispose };
  const forget = owner.own(resource);
  expect(forget).toThrow(failure);
  forget();
  expect(owner.snapshot()).toMatchObject({
    cleanups: 1,
    unresolved: [{ kind: "cleanup", error: { message: failure.message } }],
  });
  await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
  expect(releaseClaim).toHaveBeenCalledOnce();
  expect(releaseFailed).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  expect(() => authority.claim(resource)).toThrow("Resource already has a Lifetime owner");
});

it.each([
  { boundary: "disposer capture", message: "disposer capture failed" },
  { boundary: "active check", message: "Lifetime is closed to new work" },
])("retains a failed reservation rollback after $boundary", async ({ boundary, message }) => {
  const authority = createResourceAuthority();
  const rollbackFailure = new Error("claim rollback failed");
  const releaseClaim = vi.fn<() => void>(() => {
    throw rollbackFailure;
  });
  const owner = new Lifetime({
    label: "capture-owner",
    report() {},
    resourceAuthority: captureResourceAuthority({
      claim(resource: Resource) {
        authority.claim(resource);
        return releaseClaim;
      },
      markControlHandle(handle: object) {
        authority.markControlHandle(handle);
      },
    }),
  });
  const dispose = vi.fn<() => void>();
  const resource = {
    get [Symbol.dispose]() {
      if (boundary === "disposer capture") throw new Error(message);
      void owner.dispose().catch(() => undefined);
      return dispose;
    },
  };
  let failure;
  try {
    owner.use(resource);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: "Resource adoption and reservation release failed",
    errors: [expect.objectContaining({ message }), rollbackFailure],
  });
  expect(owner.snapshot()).toMatchObject({
    cleanups: 1,
    unresolved: [{ error: { errors: [{ message }, { message: rollbackFailure.message }] } }],
  });
  await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
  expect(releaseClaim).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  expect(() => authority.claim(resource)).toThrow("Resource already has a Lifetime owner");
});

it.each([
  { mode: "throw", message: "control marking failed" },
  { mode: "async", message: "ResourceAuthority.markControlHandle must be synchronous" },
])("does not start a task whose $mode control registration fails", async ({ mode, message }) => {
  const authority = createResourceAuthority();
  const failure = new Error("control marking failed");
  let rejectTask = false;
  let result: Promise<unknown> | undefined;
  const owner = createOwner({
    claim(resource) {
      return authority.claim(resource);
    },
    markControlHandle(handle) {
      authority.markControlHandle(handle);
      if (!rejectTask || !("result" in handle)) return;
      result = handle.result as Promise<unknown>;
      if (mode === "async") return Promise.reject(failure);
      throw failure;
    },
  });
  await owner.host.start();
  rejectTask = true;
  const run = vi.fn<() => void>();
  expect(() => owner.lifetime().spawn(run)).toThrow(message);
  await expect(result).rejects.toMatchObject({ message });
  await owner.host.stop();
  expect(run).not.toHaveBeenCalled();
  expect(owner.host.status).toBe("stopped");
});

it("joins and cancels a task when control registration reenters child disposal", async () => {
  const authority = createResourceAuthority();
  let stopDuringMark: (() => void) | undefined;
  const owner = createOwner({
    claim(resource) {
      return authority.claim(resource);
    },
    markControlHandle(handle) {
      authority.markControlHandle(handle);
      if (!("result" in handle) || !stopDuringMark) return;
      // oxlint-disable-next-line unicorn/no-thenable -- authority callbacks must not replace the private shutdown join
      Object.defineProperty(handle.result, "then", {
        value() {
          throw new Error("Public task result must not own shutdown's join");
        },
      });
      stopDuringMark();
    },
  });
  await owner.host.start();
  const child = owner.lifetime().child("marked-task");
  let closing!: Promise<void>;
  let closed = false;
  stopDuringMark = () => {
    closing = child[Symbol.asyncDispose]().then(() => {
      closed = true;
    });
  };
  const started = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  child.spawn(async (signal) => {
    started.resolve(signal);
    await finish.promise;
  });
  try {
    expect((await started.promise).aborted).toBe(true);
    expect(closed).toBe(false);
    finish.resolve();
    await closing;
    expect(closed).toBe(true);
  } finally {
    finish.resolve();
    await owner.host.stop();
  }
});

it("accepts a synchronous release capability without reading its unrelated then metadata", async () => {
  const authority = createResourceAuthority();
  const releaseResource = vi.fn<() => void>();
  const resource = { [Symbol.dispose]: releaseResource };
  const readThen = vi.fn<() => never>(() => {
    throw new Error("Release capability metadata must not be interpreted as a Promise");
  });
  const owner = createOwner({
    claim(value) {
      const release = authority.claim(value);
      if (value !== resource) return release;
      // oxlint-disable-next-line unicorn/no-thenable -- callable claim receipts are capabilities, not deferred results
      return Object.defineProperty(release, "then", { get: readThen });
    },
    markControlHandle: (handle) => authority.markControlHandle(handle),
  });
  await owner.host.start();
  try {
    owner.lifetime().use(resource);
    expect(() => authority.claim(resource)).toThrow("Resource already has a Lifetime owner");
  } finally {
    await owner.host.stop();
  }
  const releaseNextReservation = authority.claim(resource);
  releaseNextReservation();
  expect(releaseResource).toHaveBeenCalledOnce();
  expect(readThen).not.toHaveBeenCalled();
});

function createOwner(
  resourceAuthority: ResourceAuthority,
  setup?: (lifetime: LifetimeContext) => void,
) {
  let lifetime!: LifetimeContext;
  const host = createHost({
    resourceAuthority,
    onError() {},
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(context) {
            lifetime = context.lifetime;
            setup?.(lifetime);
          },
        }),
      },
    ],
  });
  return { host, lifetime: () => lifetime };
}
