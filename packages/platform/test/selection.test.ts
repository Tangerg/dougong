import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin, disposeSymbol } from "dougong";
import { createPlatform, type Artifact } from "../src";
import { RegistrationRecord } from "../src/catalog/registration";
import { add, deferred, emptyPlugin, fixture } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it("accepts a whole selection before notifying observers or cancelling superseded loading", async () => {
  const entered = deferred();
  const release = deferred();
  const cancelled: string[][] = [];
  const platform = createPlatform({
    id: "selection",
    host: createHost({ resourceAuthority }),
    apiVersion: "1.0.0",
    loader: {
      async load(name: string, signal: AbortSignal) {
        signal.addEventListener("abort", () => {
          cancelled.push(
            [...platform.diagnostics.get().registrations.values()].map(
              (registration) => registration.name + "@" + registration.selectedArtifact.revision,
            ),
          );
        });
        entered.resolve();
        await release.promise;
        return { default: emptyPlugin(name) };
      },
    },
  });
  const first = add(platform, "left", "left");
  const second = add(platform, "right", "right");
  const left = add(platform, "left", "left", "2.0.0");
  const right = add(platform, "right", "right", "2.0.0");
  const registrations = await platform.select([first, second]);
  const loading = platform.activate(registrations).catch((error: unknown) => error);
  await entered.promise;
  const observed: string[][] = [];
  const subscription = platform.diagnostics.subscribe(() => {
    observed.push(
      [...platform.diagnostics.get().registrations.values()].map(
        (registration) => registration.name + "@" + registration.selectedArtifact.revision,
      ),
    );
    if (platform.catalog.get("right", right.revision)) platform.catalog.remove(right);
  });
  try {
    const selected = await platform.select([left, right]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected).toEqual(registrations);
    expect(selected.map((registration) => registration.selectedArtifact)).toEqual([left, right]);
    expect(selected.map((registration) => registration.selectionRevision)).toEqual([2, 2]);
    expect(observed).toEqual([["left@2.0.0", "right@2.0.0"]]);
    expect(cancelled).toEqual(observed);
    expect(platform.catalog.get("right", right.revision)).toBeUndefined();
    expect(await loading).toMatchObject({ code: "SELECTION_SUPERSEDED" });
  } finally {
    subscription[disposeSymbol]();
    release.resolve();
    await loading;
    await platform[Symbol.asyncDispose]();
  }
});

it("rejects an unavailable member without advancing any selected revision", async () => {
  const { platform } = fixture(resourceAuthority);
  const foreign = fixture(resourceAuthority).platform;
  const original = add(platform, "sample", "one");
  const replacement = add(platform, "sample", "two", "2.0.0");
  const unavailable = add(foreign, "foreign", "foreign");
  const [registration] = await platform.select([original]);
  const before = platform.diagnostics.get();
  const changed = vi.fn<() => void>();
  using _subscription = platform.diagnostics.subscribe(changed);
  try {
    await expect(platform.select([replacement, unavailable])).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
    });
    expect(registration.selectedArtifact).toBe(original);
    expect(registration.selectionRevision).toBe(1);
    expect(platform.registrations()).toEqual([registration]);
    expect(platform.diagnostics.get()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    await platform[Symbol.asyncDispose]();
    await foreign[Symbol.asyncDispose]();
  }
});

it("rechecks the complete captured batch when the selection enters its queue", async () => {
  const { platform } = fixture(resourceAuthority);
  const original = add(platform, "sample", "one");
  const replacement = add(platform, "sample", "two", "2.0.0");
  const withdrawn = add(platform, "withdrawn", "withdrawn");
  const [registration] = await platform.select([original]);
  const before = platform.diagnostics.get();
  const selecting = platform.select([replacement, withdrawn]);
  platform.catalog.remove(withdrawn);
  try {
    await expect(selecting).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    expect(registration.selectedArtifact).toBe(original);
    expect(registration.selectionRevision).toBe(1);
    expect(platform.registrations()).toEqual([registration]);
    expect(platform.diagnostics.get()).toBe(before);
  } finally {
    await platform[Symbol.asyncDispose]();
  }
});

it("captures indexed input before queuing and returns the same positional membership", async () => {
  const { platform } = fixture(resourceAuthority);
  const first = add(platform, "first", "one");
  const second = add(platform, "second", "two");
  const replacement = add(platform, "replacement", "three");
  const input = [first, second];
  Object.setPrototypeOf(input, {
    __proto__: Array.prototype,
    [Symbol.iterator]: () => [replacement][Symbol.iterator](),
  });
  const selecting = platform.select(input);
  input[0] = replacement;
  input.length = 0;
  try {
    const registrations = await selecting;
    expect(registrations.map((registration) => registration.selectedArtifact)).toEqual([
      first,
      second,
    ]);
    expect(Object.isFrozen(registrations)).toBe(true);
  } finally {
    await platform[Symbol.asyncDispose]();
  }
});

it("rejects duplicate names, sparse arrays and accessors before any selection", async () => {
  const { platform } = fixture(resourceAuthority);
  const first = add(platform, "sample", "one");
  const second = add(platform, "sample", "two", "2.0.0");
  const getter = vi.fn<() => typeof first>(() => first);
  const accessor = Object.defineProperty([first], "1", { enumerable: true, get: getter });
  const sparse: Artifact<string>[] = [];
  sparse.length = 1;
  try {
    await expect(platform.select([first, second])).rejects.toThrow(
      "Duplicate selected Registration 'sample'",
    );
    await expect(platform.select([first, first])).rejects.toThrow(
      "Duplicate selected Registration 'sample'",
    );
    await expect(platform.select(sparse)).rejects.toThrow(TypeError);
    await expect(platform.select(accessor)).rejects.toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(platform.registrations()).toEqual([]);
    await expect(platform.select([])).resolves.toEqual([]);
  } finally {
    await platform[Symbol.asyncDispose]();
  }
});

it("rejects unowned Artifact identities without reading their fields", async () => {
  const { platform } = fixture(resourceAuthority);
  const first = add(platform, "first", "one");
  const getter = vi.fn<() => typeof first.manifest>(() => first.manifest);
  const forged = Object.defineProperty({}, "manifest", { get: getter }) as Artifact<string>;
  try {
    await expect(platform.select([first, forged])).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(platform.registrations()).toEqual([]);
  } finally {
    await platform[Symbol.asyncDispose]();
  }
});

it("materializes an unobserved selection history only when its snapshot is requested", async () => {
  const snapshot = vi.spyOn(RegistrationRecord.prototype, "snapshot");
  const { platform } = fixture(resourceAuthority);
  const count = 256;
  try {
    for (let index = 0; index < count; index++) {
      const name = String(index);
      await platform.select([add(platform, name, name)]);
    }
    expect(snapshot.mock.calls.length).toBe(0);
    const current = platform.diagnostics.get();
    expect(current.registrations.size).toBe(count);
    expect(snapshot).toHaveBeenCalledTimes(count);
    expect(platform.diagnostics.get()).toBe(current);
    expect(snapshot).toHaveBeenCalledTimes(count);
  } finally {
    snapshot.mockRestore();
    await platform[Symbol.asyncDispose]();
  }
});

it("starts subscription comparisons at the current snapshot and ignores unrelated Host changes", async () => {
  const { host, platform } = fixture(resourceAuthority);
  const artifact = add(platform, "sample", "one");
  await platform.select([artifact]);
  const changed = vi.fn<() => void>();
  using _subscription = platform.diagnostics.subscribe(changed);
  try {
    const change = host.change();
    change.install(definePlugin({ name: "native", setup() {} }), { id: "native" });
    await host.apply(await host.plan(change));
    await platform.select([artifact]);
    expect(changed).not.toHaveBeenCalled();
    const before = platform.diagnostics.get();
    await platform.select([add(platform, "sample", "two", "2.0.0")]);
    expect(changed).toHaveBeenCalledOnce();
    expect(platform.diagnostics.get()).not.toBe(before);
    expect(before.registrations.get("sample")?.selectedArtifact).toMatchObject({
      revision: "1.0.0",
    });
  } finally {
    await platform[Symbol.asyncDispose]();
  }
});
