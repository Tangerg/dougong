import { expect, it, vi } from "vitest";
import { createHost, definePlugin, type LifetimeContext, type Resource } from "../src";
import { Lifetime } from "../src/lifetime/lifetime";

const lifetime = () => new Lifetime({ label: "resource-owner", report: () => undefined });

it.each(["use", "acquire"] as const)(
  "rejects primitive resource identities at the %s boundary without recording an obligation",
  async (operation) => {
    let context!: LifetimeContext;
    const release = vi.fn<() => void>();
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "owner",
            setup({ lifetime }) {
              context = lifetime;
            },
          }),
        },
      ],
    });
    await host.start();
    try {
      const before = host.diagnostics.get().installations[0]!.lifetime;
      for (const input of [
        undefined,
        null,
        false,
        0,
        1n,
        "resource",
        Symbol("resource"),
        Symbol.for("resource"),
      ]) {
        const resource = input as unknown as Resource;
        await expect(async () => {
          if (operation === "use") context.use(resource);
          else await context.acquire(() => resource);
        }).rejects.toThrow("Resource must implement Symbol.dispose or Symbol.asyncDispose");
        expect(host.diagnostics.get().installations[0]!.lifetime).toEqual(before);
      }
      context.use({ [Symbol.dispose]: release });
    } finally {
      await host.stop();
    }
    expect(release).toHaveBeenCalledOnce();
  },
);

it("gives a resource identity one release obligation across Lifetimes and acquisition", async () => {
  const first = lifetime();
  const second = lifetime();
  const release = vi.fn<() => void>();
  const resource = { [Symbol.dispose]: release };
  const acquiring = second.acquire(() => resource);
  first.use(resource);
  try {
    await expect(acquiring).rejects.toThrow("Resource already has a Lifetime owner");
    expect(() => first.use(resource)).toThrow("Resource already has a Lifetime owner");
    await second.dispose();
    expect(release).not.toHaveBeenCalled();
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
  expect(release).toHaveBeenCalledOnce();
});

it("reserves a resource before its disposer getter can reenter another Lifetime", async () => {
  const first = lifetime();
  const second = lifetime();
  const release = vi.fn<() => void>();
  let reenter = true;
  let competing: unknown;
  const resource = {
    get [Symbol.dispose]() {
      if (reenter) {
        reenter = false;
        try {
          second.use(resource);
        } catch (error) {
          competing = error;
        }
      }
      return release;
    },
  };
  const relinquish = first.own(resource);
  try {
    expect(competing).toBeInstanceOf(TypeError);
    relinquish();
    second.use(resource);
    await first.dispose();
    expect(release).not.toHaveBeenCalled();
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
  expect(release).toHaveBeenCalledOnce();
});

it("retains the resource claim while cleanup is pending and after its failure", async () => {
  const first = lifetime();
  const second = lifetime();
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const release = vi.fn<() => Promise<void>>(() => {
    started.resolve();
    return pending.promise;
  });
  const resource = { [Symbol.asyncDispose]: release };
  const relinquish = first.own(resource);
  const closing = first.dispose();
  const failure = closing.catch((error: unknown) => error);
  try {
    await started.promise;
    expect(() => second.use(resource)).toThrow("Resource already has a Lifetime owner");
    relinquish();
    expect(() => second.use(resource)).toThrow("Resource already has a Lifetime owner");
  } finally {
    pending.reject(new Error("release failed"));
    expect(await failure).toMatchObject({ message: "Lifetime has unresolved cleanup obligations" });
  }
  await expect(second.acquire(() => resource)).rejects.toThrow(
    "Resource already has a Lifetime owner",
  );
  await second.dispose();
  expect(first.snapshot().unresolved).toHaveLength(1);
  expect(release).toHaveBeenCalledOnce();
});

it("releases a failed capture claim so the resource can be corrected and adopted", async () => {
  const first = lifetime();
  const second = lifetime();
  const release = vi.fn<() => void>();
  let failure = true;
  const resource = {
    get [Symbol.dispose]() {
      if (failure) throw new Error("capture failed");
      return release;
    },
  };
  expect(() => first.use(resource)).toThrow("capture failed");
  failure = false;
  second.use(resource);
  await Promise.all([first.dispose(), second.dispose()]);
  expect(release).toHaveBeenCalledOnce();
});

it("keeps a timed out resource claimed until its actual cleanup settles", async () => {
  vi.useFakeTimers();
  const first = new Lifetime({
    label: "timed-out",
    report: () => undefined,
    shutdownTimeoutMilliseconds: 10,
  });
  const second = lifetime();
  const pending = Promise.withResolvers<void>();
  const release = vi.fn<() => Promise<void>>(() => pending.promise);
  const resource = { [Symbol.asyncDispose]: release };
  first.use(resource);
  try {
    const closing = first.dispose();
    const failure = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await failure).toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(() => second.use(resource)).toThrow("Resource already has a Lifetime owner");
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.phase).toBe("disposed");
    second.use(resource);
    await second.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve();
    vi.useRealTimers();
    await second.dispose();
  }
});
