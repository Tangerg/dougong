import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin, type AnyPlugin } from "dougong";
import { createPlatform, defineManifest, type Platform, type Registration } from "../src";
import { add, emptyPlugin, fixture, nextTurn, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it("enumerates current command handles independently of historical snapshots", async () => {
  const { platform } = fixture(resourceAuthority);
  const artifact = add(platform, "sample", "module");
  const [first] = await platform.select([artifact]);
  const previous = platform.registrations();
  expect(Object.isFrozen(previous)).toBe(true);
  await platform.remove(first);
  const [second] = await platform.select([artifact]);
  expect(previous[0]).toBe(first);
  expect(platform.registrations()[0]).toBe(second);
  expect(second).not.toBe(first);
  await platform[Symbol.asyncDispose]();
  expect(platform.registrations()).toEqual([]);
});

it("preserves Platform snapshot identity and notifications across unrelated Core state", async () => {
  const { host, platform } = fixture(
    resourceAuthority,
    new Map([["sample", emptyPlugin("sample")]]),
  );
  const registration = await select(platform, "sample", "sample");
  const before = platform.diagnostics.get();
  const changed = vi.fn<() => void>();
  using _subscription = platform.diagnostics.subscribe(changed);
  await platform.select([registration.selectedArtifact]);
  await host.start();
  const change = host.change();
  change.install(emptyPlugin("native"), { id: "native" });
  await host.apply(await host.plan(change));
  expect(platform.diagnostics.get()).toBe(before);
  expect(changed).not.toHaveBeenCalled();
  await platform.activate([registration]);
  expect(changed).toHaveBeenCalled();
  expect(platform.diagnostics.get().registrations.get("sample")?.execution).toBe("running");
  await platform[Symbol.asyncDispose]();
  await host.stop();
});

it("does not mark an installed selected root as failed because another root failed", async () => {
  const { platform } = fixture(resourceAuthority, new Map([["good", emptyPlugin("good")]]));
  const good = await select(platform, "good", "good");
  const bad = await select(platform, "bad", "missing");
  await platform.activate([good]);
  await expect(platform.activate([good, bad])).rejects.toMatchObject({
    code: "MODULE_LOAD_FAILED",
  });
  expect(good.status).toBe("installed");
  expect(good.error).toBeUndefined();
  expect(bad.status).toBe("failed");
  await platform[Symbol.asyncDispose]();
});

it("does not accept a different artifact name as the selected revision's active origin", async () => {
  const { host, platform } = fixture(
    resourceAuthority,
    new Map([["sample", emptyPlugin("sample")]]),
  );
  const sample = await select(platform, "sample", "sample");
  await platform.activate([sample]);
  const change = host.change();
  change.update(sample.installation!, {
    plugin: emptyPlugin("replacement"),
    origin: {
      kind: "artifact",
      platformId: platform.id,
      revision: sample.selectedArtifact.revision,
      manifest: { name: "different", version: "1.0.0" },
    },
  });
  await host.apply(await host.plan(change));
  expect(sample.activeOrigin).toBeUndefined();
  expect(platform.preview([sample]).selections[0]?.action).toBe("update");
  await platform.activate([sample]);
  expect(sample.activeOrigin?.manifest.name).toBe("sample");
  await platform[Symbol.asyncDispose]();
});

it.each(["activation", "permissions"] as const)(
  "does not execute accessors in manifest %s",
  (field) => {
    const getter = vi.fn<() => string>(() => "arbitrary-user-code");
    const values = Object.defineProperty([], "0", { enumerable: true, get: getter });
    expect(() => defineManifest({ name: "sample", version: "1.0.0", [field]: values })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
  },
);

it.each(["validation", "admission", "setup", "release"] as const)(
  "rejects commands that would await their own %s callback",
  async (phase) => {
    let platform!: Platform<string>;
    let registration!: Registration<string>;
    let outcome: unknown;
    const probe = async () => {
      const attempt =
        phase === "release"
          ? platform[Symbol.asyncDispose]()
          : phase === "setup"
            ? platform.remove(registration)
            : phase === "admission"
              ? platform.activate([])
              : platform.select([registration.selectedArtifact]);
      outcome = await Promise.race([
        attempt.then(
          () => "resolved",
          (error: unknown) => error,
        ),
        nextTurn().then(() => "blocked on itself"),
      ]);
    };
    const plugin = definePlugin({
      name: "sample",
      configuration: {
        "~standard": {
          version: 1,
          vendor: "test",
          async validate(input) {
            if (phase === "validation") await probe();
            return { value: input };
          },
        },
      },
      async setup({ lifetime }) {
        if (phase === "setup") await probe();
        if (phase === "release") lifetime.defer(probe);
      },
    });
    const host = createHost({ resourceAuthority });
    platform = createPlatform({
      id: "reentry",
      host,
      apiVersion: "1.0.0",
      loader: { load: () => ({ default: plugin }) },
      authorizer: {
        async authorize({ operation }) {
          if (phase === "admission" && operation === "activate") await probe();
        },
      },
    });
    await host.start();
    registration = await select(platform, "sample", "one");
    await platform.activate([registration]);
    await platform[Symbol.asyncDispose]();
    expect(outcome).toMatchObject({ code: "PLATFORM_BUSY", details: { outcome: "rejected" } });
    await host.stop();
  },
);

it("does not pin withdrawn artifact references or loaded plugins for a live Platform", async () => {
  const platform = createPlatform({
    id: "cache-lifetime",
    host: createHost({ resourceAuthority }),
    apiVersion: "1.0.0",
    loader: { load: (reference: { plugin: AnyPlugin }) => ({ default: reference.plugin }) },
  });
  async function retired() {
    const plugin = emptyPlugin("retired");
    const reference = { plugin };
    const artifact = add(platform, "retired", reference);
    const [registration] = await platform.select([artifact]);
    await platform.activate([registration]);
    await platform.remove(registration);
    platform.catalog.remove(artifact);
    return [new WeakRef(reference), new WeakRef(plugin), new WeakRef(artifact)];
  }
  await expectCollected(await retired());
  expect(platform.status).toBe("active");
  await platform[Symbol.asyncDispose]();
});

it("detaches an aborted caller while a different caller still waits on a shared module", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const platform = createPlatform({
    id: "waiter-lifetime",
    host: createHost({ resourceAuthority }),
    apiVersion: "1.0.0",
    loader: {
      async load() {
        entered.resolve();
        await resume.promise;
        return { default: emptyPlugin("sample") };
      },
    },
  });
  const registration = await select(platform, "sample", "one");
  const pending = platform.activate([registration]);
  await entered.promise;
  async function cancelled() {
    const controller = new AbortController();
    const reason = { request: "aborted" };
    const attempt = platform
      .activate([registration], { signal: controller.signal })
      .catch((error: unknown) => error);
    await nextTurn();
    controller.abort(reason);
    expect(await attempt).toBe(reason);
    return new WeakRef(reason);
  }
  try {
    await expectCollected([await cancelled()]);
  } finally {
    resume.resolve();
    await pending;
    await platform[Symbol.asyncDispose]();
  }
});

async function expectCollected(references: ReadonlyArray<WeakRef<object>>) {
  const collectGarbage = globalThis.gc;
  if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
  for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
    await nextTurn();
    collectGarbage();
    collectGarbage();
  }
  expect(references.map((reference) => reference.deref() === undefined)).toEqual(
    references.map(() => true),
  );
}

it("validates cycles in retained committed origins as well as the selected closure", async () => {
  const { host, platform } = fixture(
    resourceAuthority,
    new Map([
      ["existing", emptyPlugin("existing")],
      ["new", emptyPlugin("new")],
    ]),
  );
  const existing = await select(platform, "existing", "existing");
  const next = await select(platform, "new", "new");
  await platform.activate([existing]);
  const change = host.change();
  change.update(existing.installation!, {
    plugin: emptyPlugin("existing"),
    origin: {
      kind: "artifact",
      platformId: platform.id,
      revision: "external",
      manifest: { name: "existing", version: "1.0.0", dependencies: { existing: "*" } },
    },
  });
  await host.apply(await host.plan(change));
  expect(platform.preview([next]).blockers).toEqual([
    expect.objectContaining({
      code: "REGISTRATION_CYCLE",
      dependencyPath: ["existing", "existing"],
    }),
  ]);
  await expect(platform.activate([next])).rejects.toMatchObject({ code: "REGISTRATION_CYCLE" });
  await platform.activate([next], { remove: [existing] });
  await platform[Symbol.asyncDispose]();
});

it("records one immutable diagnostic for selections rejected by the same atomic activation", async () => {
  const message = vi.fn<() => string>(() => "access denied");
  const failure = Object.defineProperties(new Error(), {
    message: { get: message },
    stack: { value: "policy" },
  });
  const platform = createPlatform({
    id: "batch",
    host: createHost({ resourceAuthority }),
    apiVersion: "1.0.0",
    loader: { load: emptyPlugin },
    authorizer: {
      authorize() {
        throw failure;
      },
    },
  });
  const first = await select(platform, "first", "first");
  const second = await select(platform, "second", "second");
  await expect(platform.activate([first, second])).rejects.toBe(failure);
  expect(first.error?.message).toBe("access denied");
  expect(second.error).toBe(first.error);
  expect(message).toHaveBeenCalledTimes(1);
  await platform[Symbol.asyncDispose]();
});
