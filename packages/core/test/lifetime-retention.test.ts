import { describe, expect, it } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type Event,
  type ExtensionPoint,
  type LifetimeContext,
  type PluginContext,
  type Group,
} from "../src/index";
import { ContractRegistry } from "../src/contract-registry";
import { ExtensionRegistry, type ExtensionStore } from "../src/extension-store";
import { GroupNode } from "../src/group";
import { createInstallationSpec, InstallationRecord } from "../src/installation";

type ResourceKind =
  | "child-lifetimes"
  | "cleanups"
  | "contributions"
  | "event-subscriptions"
  | "extension-listeners"
  | "extension-subscriptions"
  | "tasks";

const RESOURCE_COUNT = 64;
const RELEASE_PASSES = 8;
const RETAINED_HANDLE_KINDS = [
  "cleanup",
  "child-lifetime",
  "contribution",
  "event-subscription",
  "extension-subscription",
  "task",
  "extension-view",
] as const;

describe("lifetime retention", () => {
  it("removes terminal resources from the active lifetime snapshot", async () => {
    const fixture = await startRetentionFixture();

    try {
      await fixture.release();

      expect(fixture.lifetime.get()).toEqual({
        label: fixture.installationId,
        phase: "active",
        cleanups: 0,
        tasks: 0,
        listeners: 0,
        contributions: 0,
        extensionViews: 1,
        subscriptions: 0,
        children: [],
      });
    } finally {
      await fixture.host.stop();
    }
  });

  it("does not strongly retain terminal resources while their parent remains active", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await startRetentionFixture();

    try {
      await fixture.release();

      const retained = await collectReleasedResources(forceGc, fixture.references);
      for (const [kind, count] of retained) {
        expect.soft(count, `${kind} remained strongly owned`).toBe(0);
      }
    } finally {
      await fixture.host.stop();
    }
  });

  it("does not retain an empty ExtensionPoint Store after its last owner releases it", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const ITEMS = extensionPoint<number>("lifetime/released-store");
    const registry = new ExtensionRegistry(() => undefined);
    const retainedStore = createAndReleaseExtensionStore(registry, ITEMS);
    for (let pass = 0; pass < RELEASE_PASSES && retainedStore.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(retainedStore.deref()).toBeUndefined();
  });

  it("does not retain owners, callbacks or payloads through retained terminal handles", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    for (const retainedKind of RETAINED_HANDLE_KINDS) {
      const fixture = await createRetainedTerminalResourceHandle(retainedKind);
      await collectNamedReferences(forceGc, fixture.references);

      for (const [name, reference] of fixture.references) {
        expect.soft(reference.deref(), `${retainedKind} retained ${name}`).toBeUndefined();
      }
      expect([...fixture.handles.keys()]).toEqual([retainedKind]);
    }
  });

  it("does not retain an active Host through a released child Lifetime", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createReleasedChildFromAbandonedApplication();
    await collectNamedReferences(forceGc, fixture.references);

    expect(fixture.references.get("application")?.deref()).toBeUndefined();
    expect(fixture.child.signal.aborted).toBe(true);
    expect(fixture.child.signal.reason).toMatchObject({
      name: "AbortError",
      message: "Resource disposed",
    });
    expect(Object.isFrozen(fixture.child.signal.reason)).toBe(true);
  });

  it("does not retain an Host through a historical Lifetime diagnostic view", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createHistoricalLifetimeDiagnostics();
    await collectNamedReferences(forceGc, fixture.references);

    expect(fixture.diagnostics.get()).toMatchObject({ phase: "disposed" });
    expect(fixture.references.get("application")?.deref()).toBeUndefined();
  });

  it("collects an abandoned active Host without retained handles", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const references = await createAbandonedActiveApplication();
    await collectNamedReferences(forceGc, references);

    expect(references.get("application")?.deref()).toBeUndefined();
  });

  it("disconnects terminal installations and Groups from their ownership trees", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = releaseTerminalOwnershipTrees();
    expect(fixture.removedGroup.parent).toBeUndefined();
    expect(fixture.record.status).toBe("removed");
    for (
      let pass = 0;
      pass < RELEASE_PASSES && fixture.references.some((ref) => ref.deref());
      pass++
    ) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.references.every((ref) => ref.deref() === undefined)).toBe(true);
  });

  it("releases registry authority from a discarded Contract draft", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = createDiscardedContractDraft();
    for (let pass = 0; pass < RELEASE_PASSES && fixture.reference.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.reference.deref()).toBeUndefined();
    expect(() => fixture.draft.remember(event("lifetime/discarded-contract"))).toThrow("discarded");
  });

  it("does not retain an Host through a removed plugin handle", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createRemovedPluginHandle();
    for (let pass = 0; pass < RELEASE_PASSES && fixture.reference.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.handle.status).toBe("removed");
    expect(fixture.reference.deref()).toBeUndefined();
  });

  it("does not retain an Host through an abandoned plugin handle", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createAbandonedPluginHandle();
    for (let pass = 0; pass < RELEASE_PASSES && fixture.reference.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.handle.status).toBe("failed");
    expect(fixture.reference.deref()).toBeUndefined();
    await expect(fixture.handle.ready()).rejects.toMatchObject({
      name: "Error",
      message: "abandoned plugin failed",
    });
  });

  it("does not retain an Host or failure stack through a removed Group handle", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createRemovedGroupHandle();
    for (let pass = 0; pass < RELEASE_PASSES && fixture.reference.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.group.status).toBe("removed");
    expect(fixture.reference.deref()).toBeUndefined();
  });

  it("does not retain configuration authority through a revoked Group handle", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const fixture = await createRevokedGroupHandle();
    for (let pass = 0; pass < RELEASE_PASSES && fixture.reference.deref(); pass++) {
      await nextTurn();
      forceGc();
      forceGc();
    }

    expect(fixture.group.status).toBe("removed");
    expect(fixture.reference.deref()).toBeUndefined();
  });
});

function createAndReleaseExtensionStore(
  registry: ExtensionRegistry,
  token: ExtensionPoint<number>,
) {
  const store: ExtensionStore<number> = registry.get(token);
  const retainedStore = new WeakRef(store);
  const contribution = store.stage("owner:1", "item", 1, () => undefined);
  contribution.publish();

  let viewLease: { dispose(): unknown } | undefined;
  const view = store.view((resource) => {
    viewLease = resource;
    return () => undefined;
  });
  contribution.dispose();
  viewLease?.dispose();
  expect(() => view.get()).toThrow("disposed");
  return retainedStore;
}

function releaseTerminalOwnershipTrees() {
  const root = GroupNode.root("retention-root");
  const removedGroup = root.create("removed");
  const siblingReference = new WeakRef(root.create("sibling"));
  removedGroup.detach();

  const pluginGroup = GroupNode.root("plugin-root");
  const pluginGroupReference = new WeakRef(pluginGroup);
  const plugin = definePlugin({
    name: "retention.terminal-plugin",
    setup(_context, _config: unknown) {},
  });
  const record = new InstallationRecord(
    "retention.terminal-plugin:1",
    1,
    pluginGroup,
    createInstallationSpec(plugin, undefined),
  );
  record.remove();

  return {
    removedGroup,
    record,
    references: [siblingReference, pluginGroupReference],
  };
}

function createDiscardedContractDraft() {
  const registry = new ContractRegistry();
  const reference = new WeakRef(registry);
  const draft = registry.draft(new Map());
  draft.discard();
  return { draft, reference };
}

async function createRemovedPluginHandle() {
  const host = createHost();
  const handle = host.install(definePlugin({ name: "retention.removed-plugin", setup() {} }));
  await host.start();
  await handle.remove();
  await host.stop();
  return { handle, reference: new WeakRef(host) };
}

async function createAbandonedPluginHandle() {
  const host = createHost();
  await host.start();
  const handle = host.install(
    definePlugin({
      name: "retention.abandoned-plugin",
      setup() {
        throw new Error("abandoned plugin failed");
      },
    }),
  );
  await host.stop();
  return { handle, reference: new WeakRef(host) };
}

async function createRemovedGroupHandle() {
  const host = createHost();
  await host.start();
  const group = host.group("retained-terminal", (plugins) => {
    plugins.install(
      definePlugin({
        name: "retention.failed-group-plugin",
        setup() {
          throw new Error("retained Group failed");
        },
      }),
    );
  });
  await group.ready().catch(() => undefined);
  await group.remove();
  await host.stop();
  return { group, reference: new WeakRef(host) };
}

async function createRevokedGroupHandle() {
  const host = createHost();
  let group: Group | undefined;
  try {
    host.group("revoked-configuration", (current) => {
      group = current;
      throw new Error("Group configuration failed");
    });
  } catch {
    // The captured handle must be terminal even when configuration throws.
  }
  if (!group) throw new TypeError("Retention fixture did not capture a Group handle");
  await host.stop();
  return { group, reference: new WeakRef(host) };
}

async function createRetainedTerminalResourceHandle(
  retainedKind: (typeof RETAINED_HANDLE_KINDS)[number],
) {
  const NOTICE = event<void>("lifetime/retained-handle-notice");
  const ITEMS = extensionPoint<object>("lifetime/retained-handle-items");
  const handles = new Map<string, object>();
  const references = new Map<string, WeakRef<object>>();
  const payload = (name: string) => {
    const value = { name };
    references.set(name, new WeakRef(value));
    return value;
  };
  const plugin = definePlugin({
    name: "lifetime.retained-handles",
    requires: { items: ITEMS },
    setup(ctx) {
      const cleanupPayload = payload("cleanup-payload");
      handles.set(
        "cleanup",
        ctx.cleanup(() => {
          throw new Error("retained cleanup failed", { cause: cleanupPayload });
        }),
      );

      const childPayload = payload("child-payload");
      const child = ctx.lifetime("retained-child");
      child.signal.addEventListener("abort", () => void childPayload);
      child.cleanup(() => {
        throw new Error("retained child cleanup failed", { cause: childPayload });
      });
      handles.set("child-lifetime", child);

      const contributionPayload = payload("contribution-payload");
      handles.set("contribution", ctx.contribute(ITEMS, "retained", contributionPayload));

      const eventPayload = payload("event-listener-payload");
      handles.set(
        "event-subscription",
        ctx.on(NOTICE, () => void eventPayload),
      );

      const extensionPayload = payload("extension-listener-payload");
      handles.set(
        "extension-subscription",
        ctx.items.subscribe(() => void extensionPayload),
      );

      const taskPayload = payload("task-payload");
      handles.set(
        "task",
        ctx.spawn((signal) => {
          signal.addEventListener("abort", () => void taskPayload);
        }),
      );
      handles.set("extension-view", ctx.items);
    },
  });
  const host = createHost();
  references.set("application", new WeakRef(host));
  host.install(plugin);
  await host.start();

  const task = handles.get("task");
  if (!task || !("result" in task) || !(task.result instanceof Promise)) {
    throw new TypeError("Retention fixture did not create a Task");
  }
  await task.result;
  for (const handle of handles.values()) {
    if ("dispose" in handle && typeof handle.dispose === "function") {
      try {
        await handle.dispose();
      } catch {
        // This fixture intentionally gives terminal handles a payload-bearing failure.
      }
    }
  }
  await host.stop();
  for (const name of [...handles.keys()]) {
    if (name !== retainedKind) handles.delete(name);
  }
  return { handles, references };
}

async function createReleasedChildFromAbandonedApplication() {
  let child: LifetimeContext | undefined;
  const plugin = definePlugin({
    name: "lifetime.released-child",
    setup(ctx) {
      child = ctx.lifetime("released-child");
    },
  });
  const host = createHost();
  const references = new Map<string, WeakRef<object>>([["application", new WeakRef(host)]]);
  host.install(plugin);
  await host.start();
  if (!child) throw new TypeError("Released child fixture did not initialize");
  await child.dispose();
  return { child, references };
}

async function createHistoricalLifetimeDiagnostics() {
  const host = createHost();
  const handle = host.install(
    definePlugin({ name: "lifetime.historical-diagnostics", setup() {} }),
  );
  const references = new Map<string, WeakRef<object>>([["application", new WeakRef(host)]]);
  await host.start();
  const diagnostics = host.diagnostics.get().installations.get(handle.id)?.lifetime;
  if (!diagnostics) throw new TypeError("Lifetime diagnostics were not published");
  await host.stop();
  return { diagnostics, references };
}

async function createAbandonedActiveApplication() {
  const host = createHost();
  host.install(definePlugin({ name: "lifetime.abandoned-active", setup() {} }));
  const references = new Map<string, WeakRef<object>>([["application", new WeakRef(host)]]);
  await host.start();
  return references;
}

async function startRetentionFixture() {
  const NOTICE = event<void>("lifetime/retention-notice");
  const ITEMS = extensionPoint<number>("lifetime/retention-items");
  const references = createReferenceGroups();
  let releaseResources: (() => Promise<void>) | undefined;
  const plugin = definePlugin({
    name: "lifetime.retention",
    requires: { items: ITEMS },
    setup(ctx) {
      releaseResources = () => createAndReleaseResources(ctx, references, NOTICE, ITEMS);
    },
  });
  const host = createHost();
  const handle = host.install(plugin);
  await host.start();

  const lifetime = host.diagnostics.get().installations.get(handle.id)?.lifetime;
  if (!lifetime) {
    await host.stop();
    throw new TypeError("Retention fixture did not publish lifetime diagnostics");
  }

  return {
    host,
    installationId: handle.id,
    lifetime,
    references,
    async release() {
      const release = releaseResources;
      releaseResources = undefined;
      if (!release) throw new TypeError("Retention fixture is unavailable or already released");
      await release();
    },
  };
}

function createReferenceGroups() {
  return new Map<ResourceKind, WeakRef<object>[]>([
    ["child-lifetimes", []],
    ["cleanups", []],
    ["contributions", []],
    ["event-subscriptions", []],
    ["extension-listeners", []],
    ["extension-subscriptions", []],
    ["tasks", []],
  ]);
}

async function createAndReleaseResources(
  ctx: PluginContext<{ readonly items: ExtensionPoint<number> }>,
  references: Map<ResourceKind, WeakRef<object>[]>,
  notice: Event<void>,
  items: ExtensionPoint<number>,
) {
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < RESOURCE_COUNT; index++) {
    const child = remember(references, "child-lifetimes", ctx.lifetime(`child-${index}`));
    pending.push(Promise.resolve(child.dispose()));

    const cleanup = remember(
      references,
      "cleanups",
      ctx.cleanup(() => undefined),
    );
    pending.push(Promise.resolve(cleanup.dispose()));

    const contribution = remember(
      references,
      "contributions",
      ctx.contribute(items, `item-${index}`, index),
    );
    contribution.dispose();

    const eventSubscription = remember(
      references,
      "event-subscriptions",
      ctx.on(notice, () => undefined),
    );
    eventSubscription.dispose();

    const extensionListener = remember(references, "extension-listeners", () => undefined);

    const subscription = remember(
      references,
      "extension-subscriptions",
      ctx.items.subscribe(extensionListener),
    );
    subscription.dispose();

    const task = remember(
      references,
      "tasks",
      ctx.spawn(() => undefined),
    );
    pending.push(task.result);
  }
  await Promise.all(pending);
}

function remember<T extends object>(
  references: Map<ResourceKind, WeakRef<object>[]>,
  kind: ResourceKind,
  resource: T,
) {
  references.get(kind)!.push(new WeakRef(resource));
  return resource;
}

async function collectReleasedResources(
  forceGc: () => void,
  references: ReadonlyMap<ResourceKind, readonly WeakRef<object>[]>,
) {
  let retained = countRetained(references);
  for (let pass = 0; pass < RELEASE_PASSES && hasRetained(retained); pass++) {
    // WeakRef collection is not tied to promise settlement. Cross several
    // event-loop and explicit GC boundaries before making it observable.
    await nextTurn();
    forceGc();
    forceGc();
    await nextTurn();
    retained = countRetained(references);
  }
  return retained;
}

async function collectNamedReferences(
  forceGc: () => void,
  references: ReadonlyMap<string, WeakRef<object>>,
) {
  for (
    let pass = 0;
    pass < RELEASE_PASSES && [...references.values()].some((reference) => reference.deref());
    pass++
  ) {
    await nextTurn();
    forceGc();
    forceGc();
    await nextTurn();
  }
}

function countRetained(references: ReadonlyMap<ResourceKind, readonly WeakRef<object>[]>) {
  return new Map(
    [...references].map(([kind, group]) => [
      kind,
      group.reduce((count, reference) => count + Number(reference.deref() !== undefined), 0),
    ]),
  );
}

function hasRetained(retained: ReadonlyMap<ResourceKind, number>) {
  return [...retained.values()].some((count) => count > 0);
}

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
