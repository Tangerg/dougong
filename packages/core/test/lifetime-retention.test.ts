import { describe, expect, it } from "vitest";
import {
  createApp,
  definePlugin,
  event,
  extension,
  type Event,
  type Extension,
  type PluginContext,
} from "../src/index";

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

describe("lifetime retention", () => {
  it("releases terminal resources while their parent lifetime remains active", async () => {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");

    const NOTICE = event<void>("lifetime/retention-notice");
    const ITEMS = extension<number>("lifetime/retention-items");
    const references = createReferenceGroups();
    let releaseResources: (() => Promise<void>) | undefined;
    const plugin = definePlugin({
      name: "lifetime.retention",
      requires: { items: ITEMS },
      setup(ctx) {
        releaseResources = () => createAndReleaseResources(ctx, references, NOTICE, ITEMS);
      },
    });
    const app = createApp();
    app.install(plugin);
    await app.start();

    try {
      const release = releaseResources;
      if (!release) throw new TypeError("Retention fixture did not start");
      await release();
      releaseResources = undefined;

      const retained = await collectReleasedResources(forceGc, references);
      for (const [kind, count] of retained) {
        expect.soft(count, `${kind} remained strongly owned`).toBe(0);
      }
    } finally {
      await app.stop();
    }
  });
});

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
  ctx: PluginContext<{ readonly items: Extension<number> }>,
  references: Map<ResourceKind, WeakRef<object>[]>,
  notice: Event<void>,
  items: Extension<number>,
) {
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < RESOURCE_COUNT; index++) {
    const child = remember(references, "child-lifetimes", ctx.lifetime());
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
