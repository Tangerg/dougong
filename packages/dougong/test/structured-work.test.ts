import { createResourceAuthority } from "dougong";
import { describe, expect, it, vi } from "vitest";
import { event, extensionPoint } from "../src/contracts/contracts";
import { Lifetime } from "../src/lifetime/lifetime";
import { EventHub } from "../src/events/event-hub";
import { ContributionRegistry } from "../src/contributions/contribution-registry";

const resourceAuthority = createResourceAuthority();

function lifetime(
  options: { shutdownTimeoutMilliseconds?: number; report?: (error: unknown) => void } = {},
) {
  return new Lifetime({
    resourceAuthority,
    label: "test",
    report: options.report ?? (() => undefined),
    ...(options.shutdownTimeoutMilliseconds === undefined
      ? {}
      : { shutdownTimeoutMilliseconds: options.shutdownTimeoutMilliseconds }),
  });
}

describe("structured work boundaries", () => {
  it("accepts symbol-only resources and releases them once in reverse order", async () => {
    const owner = lifetime();
    const trace: string[] = [];
    owner.handle.use({
      [Symbol.dispose]() {
        trace.push("first");
      },
    });
    owner.handle.use({
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        trace.push("second");
      },
    });
    owner.handle.defer(() => {
      trace.push("third");
    });
    await owner.dispose();
    await owner.dispose();
    expect(trace).toEqual(["third", "second", "first"]);
    expect(owner.snapshot()).toMatchObject({ phase: "disposed", cleanups: 0, unresolved: [] });
  });

  it("refuses ownership if reading a resource protocol closes its Lifetime", async () => {
    const owner = lifetime();
    const release = vi.fn<() => void>();
    let closing: Promise<void> | undefined;
    const resource = {
      get [Symbol.dispose]() {
        closing = owner.dispose();
        return release;
      },
    };
    expect(() => owner.use(resource)).toThrow("closed");
    await closing;
    expect(owner.snapshot()).toMatchObject({ phase: "disposed", cleanups: 0 });
    expect(release).not.toHaveBeenCalled();
    release();
  });

  it("treats a null asynchronous method as absent under the standard disposal protocol", async () => {
    const owner = lifetime();
    const release = vi.fn<() => void>();
    owner.use({ [Symbol.asyncDispose]: null, [Symbol.dispose]: release });
    await owner.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects shutdown before changing an in-flight foreground generation", async () => {
    const owner = lifetime();
    const pending = Promise.withResolvers<void>();
    let released = false;
    owner.defer(() => {
      released = true;
    });
    const call = owner.borrow(() => pending.promise);
    await expect(owner.dispose()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    expect(owner.phase).toBe("active");
    expect(released).toBe(false);
    pending.resolve();
    await call;
    await owner.dispose();
    expect(released).toBe(true);
  });

  it("blocks a whole ownership tree without aborting or releasing borrowed resources", async () => {
    const changed = vi.fn<() => void>();
    const owner = new Lifetime({
      resourceAuthority,
      label: "blocked",
      report: () => undefined,
      changed,
    });
    const child = owner.resolveOwner({ lifetime: owner.child("child") });
    const pending = Promise.withResolvers<void>();
    const release = vi.fn<() => void>();
    const abort = vi.fn<() => void>();
    child.defer(release);
    child.signal.addEventListener("abort", abort);
    const foreground = child.borrow(() => pending.promise);
    changed.mockClear();
    owner.block();
    expect(owner.snapshot()).toMatchObject({
      phase: "sealed",
      children: [{ phase: "sealed", foreground: 1 }],
    });
    expect(changed).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(() => child.borrow(() => undefined)).toThrow("closed");
    await expect(owner.dispose()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    pending.resolve();
    await foreground;
    await owner.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps an event receiver alive until its handler finishes", async () => {
    const owner = lifetime();
    const hub = new EventHub();
    const pending = Promise.withResolvers<void>();
    let released = false;
    owner.defer(() => {
      released = true;
    });
    hub.stage(
      "work",
      async () => {
        await pending.promise;
        expect(released).toBe(false);
      },
      owner,
    );
    owner.publish();
    const delivery = hub.emit("work", undefined);
    await expect(owner.dispose()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    pending.resolve();
    await delivery;
    await owner.dispose();
    expect(released).toBe(true);
  });

  it("does not publish candidate listeners and rejects candidate emission", async () => {
    const owner = lifetime();
    const hub = new EventHub();
    const notice = event<void>("candidate");
    const events = hub.scope(owner, () => undefined);
    const listener = vi.fn<() => void>();
    events.on(notice, listener);
    await hub.emit(notice.id, undefined);
    expect(listener).not.toHaveBeenCalled();
    await expect(events.emit(notice)).rejects.toMatchObject({ code: "EVENT_BEFORE_COMMIT" });
    owner.publish();
    await events.emit(notice);
    expect(listener).toHaveBeenCalledOnce();
    await owner.dispose();
    await expect(events.emit(notice)).rejects.toMatchObject({ code: "LIFETIME_DISPOSED" });
  });

  it("attributes explicit child event ownership to the child borrow", async () => {
    const owner = lifetime();
    const child = owner.handle.child("session");
    const hub = new EventHub();
    const notice = event<void>("child-work");
    const pending = Promise.withResolvers<void>();
    const events = hub.scope(owner, () => undefined);
    let released = false;
    child.defer(() => {
      released = true;
    });
    events.on(notice, () => pending.promise, { lifetime: child });
    owner.publish();
    const delivery = events.emit(notice);
    await expect(child[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    expect(owner.busy).toBe(true);
    expect(released).toBe(false);
    pending.resolve();
    await delivery;
    await child[Symbol.asyncDispose]();
    expect(released).toBe(true);
    await owner.dispose();
  });

  it("rejects forged and unrelated lifetime ownership", async () => {
    const owner = lifetime();
    const other = lifetime();
    const hub = new EventHub();
    const events = hub.scope(owner, () => undefined);
    const notice = event<void>("foreign");
    expect(() => events.on(notice, () => undefined, { lifetime: other.handle })).toThrow(
      "current scope tree",
    );
    expect(() => events.on(notice, () => undefined, { lifetime: {} as never })).toThrow(
      "current scope tree",
    );
    await owner.dispose();
    await other.dispose();
  });

  it("borrows a contribution owner for executable values", async () => {
    const owner = lifetime();
    const registry = new ContributionRegistry(() => undefined);
    const point = extensionPoint<{ run(): Promise<void> }>("commands");
    const pending = Promise.withResolvers<void>();
    const contributions = registry.scope(owner, "plugin", () => undefined);
    contributions.add(point, "run", { run: () => pending.promise });
    const view = registry.view<{ run(): Promise<void> }>(point);
    owner.publish();
    const invocation = view.use("plugin/run", (command) => command.run());
    await expect(owner.dispose()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    pending.resolve();
    await invocation;
    await owner.dispose();
    await expect(view.use("plugin/run", (command) => command.run())).rejects.toThrow(
      "not available",
    );
  });

  it("does not report foreground event failures a second time", async () => {
    const report = vi.fn<(error: unknown) => void>();
    const owner = lifetime({ report });
    const hub = new EventHub();
    const failure = new Error("listener failed");
    hub.stage(
      "failure",
      () => {
        throw failure;
      },
      owner,
    );
    owner.publish();
    await expect(hub.emit("failure", undefined)).rejects.toMatchObject({ errors: [failure] });
    expect(report).not.toHaveBeenCalled();
    expect(owner.busy).toBe(false);
    await owner.dispose();
  });

  it("retains failed release obligations and never blindly retries them", async () => {
    const owner = lifetime();
    const failure = new Error("resource still live");
    const release = vi.fn<() => void>(() => {
      throw failure;
    });
    const cleanup = owner.defer(release);
    await expect(cleanup[Symbol.asyncDispose]()).rejects.toBe(failure);
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(owner.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(release).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({
      phase: "quarantined",
      cleanups: 1,
      unresolved: [{ kind: "cleanup", error: { message: "resource still live" } }],
    });
    expect(() => owner.handle.defer(() => undefined)).toThrow("closed");
  });

  it("interrupts blocking IO before joining tasks and finally releases resources", async () => {
    const owner = lifetime();
    const blockedOperation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const trace: string[] = [];
    owner.signal.addEventListener(
      "abort",
      () => {
        trace.push("abort");
      },
      { once: true },
    );
    owner.interrupt(() => {
      trace.push("interrupt");
      blockedOperation.resolve();
    });
    owner.defer(() => {
      trace.push("release");
    });
    owner.spawn(async () => {
      started.resolve();
      await blockedOperation.promise;
      trace.push("joined");
    });
    await started.promise;
    await owner.dispose();
    expect(trace).toEqual(["abort", "interrupt", "joined", "release"]);
  });

  it("starts every interruption before waiting for any of them to release blocked work", async () => {
    const owner = lifetime();
    const blockedOperation = Promise.withResolvers<void>();
    const finalCleanup = vi.fn<() => void>();
    owner.defer(finalCleanup);
    const task = owner.spawn(() => blockedOperation.promise);
    const interruptOperation = vi.fn<() => void>(blockedOperation.resolve);
    owner.interrupt(interruptOperation);
    owner.interrupt(() => task.result);
    const closing = owner.dispose();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(interruptOperation).toHaveBeenCalledOnce();
    } finally {
      blockedOperation.resolve();
      await closing;
    }
    expect(finalCleanup).toHaveBeenCalledOnce();
  });

  it("retains failed interruptions independently after every interruption was attempted", async () => {
    const owner = lifetime();
    const first = new Error("socket interrupt failed");
    const second = new Error("reader interrupt failed");
    const interrupted = vi.fn<() => void>();
    owner.interrupt(() => {
      throw first;
    });
    owner.interrupt(interrupted);
    owner.interrupt(() => {
      throw second;
    });
    await expect(owner.dispose()).rejects.toMatchObject({ errors: [second, first] });
    expect(interrupted).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({
      phase: "quarantined",
      interrupts: 2,
      unresolved: [
        { kind: "interrupt", error: { message: first.message } },
        { kind: "interrupt", error: { message: second.message } },
      ],
    });
  });

  it("cancels owned tasks and children even when a plugin consumes the public abort event", async () => {
    const owner = lifetime();
    owner.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const child = owner.child("operation");
    child.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const entered = Promise.withResolvers<AbortSignal>();
    const gate = Promise.withResolvers<void>();
    const task = child.spawn((signal) => {
      entered.resolve(signal);
      return gate.promise;
    });
    const taskSignal = await entered.promise;
    owner.interrupt(() => task.result);
    const closing = owner.dispose();
    try {
      expect([child.signal.aborted, taskSignal.aborted]).toEqual([true, true]);
    } finally {
      gate.resolve();
      await closing;
    }
  });

  it("publishes, inspects, borrows from and drains deep ownership without using the JS call stack", async () => {
    const owner = lifetime();
    let deepest = owner.handle;
    const depth = 6000;
    for (let level = 0; level < depth; level++) deepest = deepest.child("nested");
    const leaf = owner.resolveOwner({ lifetime: deepest });
    const trace: string[] = [];
    owner.defer(() => trace.push("root"));
    deepest.defer(() => trace.push("leaf"));
    leaf.stage(() => ({
      handle: Object.freeze({}),
      publish: () => trace.push("publish"),
      [Symbol.dispose]: () => trace.push("withdraw"),
    }));
    owner.publish();
    let snapshot = owner.snapshot();
    let count = 0;
    while (snapshot.children.length) {
      count++;
      snapshot = snapshot.children[0]!;
    }
    expect(count).toBe(depth);
    const gate = Promise.withResolvers<void>();
    const borrowed = leaf.borrow(() => gate.promise);
    await expect(owner.dispose()).rejects.toMatchObject({ code: "LIFETIME_BUSY" });
    gate.resolve();
    await borrowed;
    await owner.dispose();
    expect(trace).toEqual(["publish", "withdraw", "leaf", "root"]);
    expect(owner.snapshot().children).toEqual([]);
  });

  it("owns setup work until it settles without background error reporting", async () => {
    const report = vi.fn<(error: unknown) => void>();
    const owner = lifetime({ report });
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const work = owner.run(async (signal) => {
      started.resolve();
      await pending.promise;
      signal.throwIfAborted();
    });
    await started.promise;
    const rejected = work.catch((error) => error);
    let stopped = false;
    const stopping = owner.dispose().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(owner.snapshot().tasks).toBe(1);
    pending.resolve();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    await stopping;
    expect(report).not.toHaveBeenCalled();
  });

  it("delivers exactly the resource whose disposer it adopted, without assimilating it again", async () => {
    const owner = lifetime();
    const dispose = vi.fn<() => void>();
    const raw = { [Symbol.dispose]: dispose };
    let reads = 0;
    const substitute = { [Symbol.dispose]() {} };
    const resource = new Proxy(raw, {
      get(target, key, receiver) {
        if (key === "then")
          return ++reads === 1
            ? undefined
            : (resolve: (value: typeof substitute) => void) => resolve(substitute);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const receipt = await owner.handle.acquire(() => resource);
      expect(receipt.resource).toBe(resource);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(reads).toBe(1);
    } finally {
      await owner.dispose();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reclaims a resource that arrives after cancellation", async () => {
    const owner = lifetime();
    const pending = Promise.withResolvers<{ [Symbol.dispose](): void }>();
    const release = vi.fn<() => void>();
    const acquisition = owner.acquire(() => pending.promise);
    const rejected = acquisition.catch((error) => error);
    const stopping = owner.dispose();
    expect(owner.snapshot().acquisitions).toBe(1);
    pending.resolve({ [Symbol.dispose]: release });
    expect(await rejected).toMatchObject({ name: "AbortError" });
    await stopping;
    expect(release).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({ phase: "disposed", acquisitions: 0, cleanups: 0 });
  });

  it("keeps parent resources until a timed out child actually finishes", async () => {
    const owner = lifetime({ shutdownTimeoutMilliseconds: 10 });
    const child = owner.child("pending-child");
    const pending = Promise.withResolvers<void>();
    let released = false;
    owner.defer(() => {
      released = true;
    });
    const task = child.spawn(() => pending.promise);
    await expect(child[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await expect(owner.dispose()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(released).toBe(false);
    pending.resolve();
    await task.result;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(true);
    expect(owner.phase).toBe("disposed");
  });

  it("retains parent resources after a child release fails", async () => {
    const owner = lifetime();
    const parentRelease = vi.fn<() => void>();
    const childRelease = vi.fn<() => void>(() => {
      throw new Error("child still owns its resource");
    });
    owner.defer(parentRelease);
    owner.child("child").defer(childRelease);
    await expect(owner.dispose()).rejects.toThrow("unresolved cleanup obligations");
    expect(parentRelease).not.toHaveBeenCalled();
    expect(childRelease).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({
      phase: "quarantined",
      cleanups: 1,
      children: [{ phase: "quarantined", cleanups: 1, unresolved: [{ kind: "cleanup" }] }],
    });
    await expect(owner.dispose()).rejects.toThrow("unresolved cleanup obligations");
    expect(parentRelease).not.toHaveBeenCalled();
    expect(childRelease).toHaveBeenCalledOnce();
  });

  it("quarantines a timed out shutdown while retaining pending work", async () => {
    const owner = lifetime({ shutdownTimeoutMilliseconds: 10 });
    const pending = Promise.withResolvers<void>();
    const task = owner.spawn(() => pending.promise);
    const stopping = owner.dispose();
    await expect(stopping).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(owner.snapshot()).toMatchObject({
      phase: "quarantined",
      tasks: 1,
      unresolved: [{ kind: "shutdown" }],
    });
    expect(owner.snapshot().unresolved[0]).not.toHaveProperty("id");
    pending.resolve();
    await task.result;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(owner.snapshot()).toMatchObject({ phase: "disposed", tasks: 0, unresolved: [] });
  });
});

it.each(["use", "acquire"] as const)(
  "preserves structural ownership when %s receives an existing child Lifetime",
  async (operation) => {
    const root = lifetime();
    const parent = root.child("parent");
    const child = parent.child("child");
    const release = vi.fn<() => void>();
    child.defer(release);
    for (const resource of [child, parent]) {
      await expect(async () => {
        if (operation === "use") child.use(resource);
        else await child.acquire(() => resource);
      }).rejects.toThrow("Owned control handles cannot be adopted as resources");
    }
    expect(root.snapshot().children[0]?.children[0]).toMatchObject({
      cleanups: 1,
      acquisitions: 0,
    });
    await root.dispose();
    expect(release).toHaveBeenCalledOnce();
  },
);
