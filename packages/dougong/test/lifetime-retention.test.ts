import { describe, expect, it } from "vitest";
import { event, extensionPoint, service } from "../src/contracts/contracts";
import { createResourceAuthority, type Resource } from "../src/contracts/resource";
import { ContractRegistry } from "../src/contracts/contract-registry";
import { Lifetime, type ChildLifetime, type LifetimeContext } from "../src/lifetime/lifetime";
import { EventHub } from "../src/events/event-hub";
import { ContributionRegistry } from "../src/contributions/contribution-registry";
import { createHost } from "../src/execution/host";
import { definePlugin } from "../src/composition/plugin";
import type { Host } from "../src/execution/host-api";

const resourceAuthority = createResourceAuthority();

const RESOURCE_COUNT = 64;
const RELEASE_PASSES = 8;
const HANDLE_KINDS = [
  "cleanup",
  "child",
  "contribution",
  "listener",
  "subscription",
  "task",
  "view",
  "logger",
  "events",
  "contributions",
] as const;
const empty = definePlugin({ name: "empty", setup() {} });

function forceGc() {
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collect) throw new TypeError("Retention tests require Node.js --expose-gc");
  collect();
  collect();
}

async function collect(references: readonly WeakRef<object>[]) {
  for (
    let pass = 0;
    pass < RELEASE_PASSES && references.some((reference) => reference.deref());
    pass++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    forceGc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function release(resource: Resource) {
  if (Symbol.asyncDispose in resource) await resource[Symbol.asyncDispose]();
  else resource[Symbol.dispose]();
}

describe("lifetime retention", () => {
  it("does not retain a completed Task payload after rejecting another owner", async () => {
    const owner = new Lifetime({ resourceAuthority, label: "task-owner", report() {} });
    const other = new Lifetime({ resourceAuthority, label: "other", report() {} });
    try {
      const reference = await rejectedTaskAdoption(owner, other);
      expect(owner.snapshot().tasks).toBe(0);
      expect(other.snapshot().cleanups).toBe(0);
      await collect([reference]);
      expect(reference.deref()).toBeUndefined();
      expect(other.phase).toBe("active");
    } finally {
      await Promise.all([owner.dispose(), other.dispose()]);
    }
  });

  it("detaches terminal resources while their parent is still active", async () => {
    const owner = new Lifetime({ resourceAuthority, label: "active", report: () => undefined });
    const events = new EventHub().scope(owner, () => undefined);
    const registry = new ContributionRegistry(() => undefined);
    const items = extensionPoint<number>("retention/items");
    const contributions = registry.scope(owner, "owner", () => undefined);
    const view = registry.view<number>(items, owner);
    owner.publish();
    const baseline = owner.snapshot();
    const references = await createAndReleaseResources(owner, events, contributions, view);
    expect(owner.snapshot()).toEqual(baseline);
    await collect(references);
    for (const reference of references) expect.soft(reference.deref()).toBeUndefined();
    await owner.dispose();
  });

  it("releases an empty ContributionStore after its final owner", async () => {
    const registry = new ContributionRegistry(() => undefined);
    const reference = await releasedStore(registry);
    await collect([reference]);
    expect(reference.deref()).toBeUndefined();
  });

  it.each(HANDLE_KINDS)(
    "does not retain a Host or payload through a released %s handle",
    async (kind) => {
      const fixture = await retainedHandle(kind);
      await collect([...fixture.references.values()]);
      for (const [name, reference] of fixture.references)
        expect.soft(reference.deref(), `${kind} retained ${name}`).toBeUndefined();
      expect(fixture.handle).toBeDefined();
    },
  );

  it("does not retain an active Host through a released child scope", async () => {
    const fixture = await releasedChild();
    await collect([fixture.host]);
    expect(fixture.host.deref()).toBeUndefined();
    expect(fixture.child.signal.aborted).toBe(true);
    expect(fixture.child.signal.reason).toMatchObject({
      name: "AbortError",
      message: "Resource disposed",
    });
    expect(Object.isFrozen(fixture.child.signal.reason)).toBe(true);
  });

  it.each(["child", "root"] as const)(
    "detaches structural authority callbacks from a released %s handle",
    async (kind) => {
      const fixture = await releasedAuthorityScope(kind);
      await collect([...fixture.references.values()]);
      for (const [name, reference] of fixture.references)
        expect.soft(reference.deref(), `Released ${kind} retained ${name}`).toBeUndefined();
      expect(fixture.handle.signal.aborted).toBe(true);
    },
  );

  it("detaches terminal views and root handles after deferred provider retirement", async () => {
    const fixture = await completedLateRetirement();
    await collect([...fixture.references.values()]);
    for (const [name, reference] of fixture.references)
      expect.soft(reference.deref(), `Late retirement retained ${name}`).toBeUndefined();
    expect(fixture.view.get()).toMatchObject({ status: "quarantined", unresolved: [] });
    expect(fixture.owner.signal.aborted).toBe(true);
    expect(fixture.subscription).toBeDefined();
  });

  it("keeps historical lifetime values without retaining their Host", async () => {
    const fixture = await historicalSnapshot(false);
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.snapshot.installations[0]?.lifetime?.phase).toBe("active");
  });

  it("captures historical failures without retaining Error causes or their Host", async () => {
    const fixture = await historicalSnapshot(true);
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.snapshot.error).toBeDefined();
  });

  it("collects an abandoned active Host without retained capabilities", async () => {
    const reference = await abandonedHost();
    await collect([reference]);
    expect(reference.deref()).toBeUndefined();
  });

  it.each([
    { kind: "diagnostics", afterQuarantine: false },
    { kind: "diagnostics", afterQuarantine: true },
    { kind: "contributions", afterQuarantine: false },
    { kind: "contributions", afterQuarantine: true },
  ] as const)(
    "releases execution through a terminal $kind view (created after quarantine: $afterQuarantine)",
    async ({ kind, afterQuarantine }) => {
      const fixture = await terminalView(kind, afterQuarantine);
      await collect([...fixture.references.values()]);
      for (const [name, reference] of fixture.references) {
        expect.soft(reference.deref(), `Terminal view retained ${name}`).toBeUndefined();
      }
      expect(fixture.view.get()).toBeDefined();
      fixture.subscription?.[Symbol.dispose]();
    },
  );

  it("releases registry authority from a discarded Contract writer", async () => {
    const fixture = discardedWriter();
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(() => fixture.writer.remember(event("retention/discarded"))).toThrow("discarded");
  });

  it("does not retain a Host through a removed Installation", async () => {
    const fixture = await removedInstallation();
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.installation.status).toBe("removed");
  });

  it.each([true, false])(
    "does not retain a Host through a rejected candidate handle (stack: %s)",
    async (stack) => {
      const fixture = await rejectedCandidate(stack);
      await collect([fixture.reference]);
      expect(fixture.reference.deref()).toBeUndefined();
      expect(fixture.installation.status).not.toBe("running");
      expect(fixture.error).toBeDefined();
    },
  );

  it("does not retain a Host through a removed ownership Group", async () => {
    const fixture = await removedGroup();
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.group.id).toBe("parent");
  });

  it("does not grant late Group declarations authority during ancestor removal", async () => {
    const fixture = await lateGroup();
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.group.id).toBe("late");
  });

  it.each([false, true])(
    "a pending Installation alone cannot retain the Engine (planned: %s)",
    async (planned) => {
      const fixture = await abandonedInstallation(planned);
      await collect([fixture.reporter]);
      expect(fixture.reporter.deref()).toBeUndefined();
      expect(fixture.installation.status).toBe("pending");
    },
  );

  it("does not retain configuration authority through an unapplied Group declaration", async () => {
    const fixture = unappliedGroup();
    await collect([fixture.reference]);
    expect(fixture.reference.deref()).toBeUndefined();
    expect(fixture.group.id).toBe("unapplied");
  });
});

async function rejectedTaskAdoption(owner: Lifetime, other: Lifetime) {
  const payload = { description: "completed task result" };
  const task = owner.spawn(() => payload);
  expect(() => other.use(task)).toThrow(TypeError);
  await task.result;
  return new WeakRef(payload);
}

async function createAndReleaseResources(
  owner: Lifetime,
  events: ReturnType<EventHub["scope"]>,
  contributions: ReturnType<ContributionRegistry["scope"]>,
  view: ReturnType<ContributionRegistry["view"]>,
) {
  const references: WeakRef<object>[] = [];
  const remember = <T extends object>(value: T) => {
    references.push(new WeakRef(value));
    return value;
  };
  const pending: PromiseLike<unknown>[] = [];
  const notice = event<void>("retention/notice");
  const items = extensionPoint<number>("retention/items");
  for (let index = 0; index < RESOURCE_COUNT; index++) {
    pending.push(remember(owner.child(`child-${index}`))[Symbol.asyncDispose]());
    pending.push(remember(owner.defer(() => undefined))[Symbol.asyncDispose]());
    remember(contributions.add(items, `item-${index}`, index))[Symbol.dispose]();
    remember(events.on(notice, () => undefined))[Symbol.dispose]();
    remember(view.subscribe(remember(() => undefined)))[Symbol.dispose]();
    pending.push(remember(owner.spawn(() => undefined)).result);
  }
  await Promise.all(pending);
  return references;
}

async function releasedStore(registry: ContributionRegistry) {
  const owner = new Lifetime({ resourceAuthority, label: "store-owner", report: () => undefined });
  const point = extensionPoint<number>("retention/released-store");
  const store = registry.store<number>(point);
  const reference = new WeakRef(store);
  store.stage("owner/item", 1, owner, () => undefined);
  registry.view(point, owner);
  owner.publish();
  await owner.dispose();
  return reference;
}

async function retainedHandle(kind: (typeof HANDLE_KINDS)[number]) {
  const references = new Map<string, WeakRef<object>>();
  const handles = new Map<string, object>();
  const payload = (name: string) => {
    const value = { name };
    references.set(name, new WeakRef(value));
    return value;
  };
  const point = extensionPoint<object>("retention/payloads");
  const notice = event<void>("retention/payload-notice");
  const plugin = definePlugin({
    name: "retained",
    requires: { values: point },
    setup(context) {
      const cleanupPayload = payload("cleanup payload");
      handles.set(
        "cleanup",
        context.lifetime.defer(() => {
          void cleanupPayload;
        }),
      );
      const childPayload = payload("child payload");
      const child = context.lifetime.child("child");
      child.signal.addEventListener("abort", () => {
        void childPayload;
      });
      child.defer(() => {
        void childPayload;
      });
      handles.set("child", child);
      handles.set(
        "contribution",
        context.contributions.add(point, "payload", payload("contribution payload")),
      );
      const listenerPayload = payload("listener payload");
      handles.set(
        "listener",
        context.events.on(notice, () => {
          void listenerPayload;
        }),
      );
      const subscriberPayload = payload("subscriber payload");
      handles.set(
        "subscription",
        context.dependencies.values.subscribe(() => {
          void subscriberPayload;
        }),
      );
      const taskPayload = payload("task payload");
      const task = context.lifetime.spawn((signal) => {
        signal.addEventListener("abort", () => {
          void taskPayload;
        });
      });
      handles.set("task", task);
      handles.set("view", context.dependencies.values);
      handles.set("logger", context.logger);
      handles.set("events", context.events);
      handles.set("contributions", context.contributions);
    },
  });
  const loggerPayload = payload("logger payload");
  const write = () => {
    void loggerPayload;
  };
  const host = createHost({
    resourceAuthority,
    logger: { debug: write, info: write, warn: write, error: write },
    installations: [{ id: "retained", plugin }],
  });
  references.set("Host", new WeakRef(host));
  await host.start();
  const task = handles.get("task") as { result: Promise<void> };
  await task.result;
  await host.stop();
  const handle = handles.get(kind)!;
  return { handle, references };
}

async function releasedChild() {
  let child!: ChildLifetime;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "child",
        plugin: definePlugin({
          name: "child",
          setup({ lifetime }) {
            child = lifetime.child("released");
          },
        }),
      },
    ],
  });
  await host.start();
  await release(child);
  return { child, host: new WeakRef(host) };
}

async function releasedAuthorityScope(kind: "child" | "root") {
  const backend: { host: Host | undefined } = { host: undefined };
  const authority = {
    claim: (resource: Resource) => resourceAuthority.claim(resource),
    markControlHandle(handle: object) {
      resourceAuthority.markControlHandle(handle);
      void backend.host;
    },
  };
  let handle!: LifetimeContext;
  const host = createHost({
    resourceAuthority: authority,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            handle = kind === "child" ? lifetime.child("released") : lifetime;
          },
        }),
      },
    ],
  });
  backend.host = host;
  await host.start();
  if (kind === "child") await (handle as ChildLifetime)[Symbol.asyncDispose]();
  else await host.stop();
  return {
    handle,
    references: new Map<string, WeakRef<object>>([
      ["Host", new WeakRef(host)],
      ["authority", new WeakRef(authority)],
      ["backend", new WeakRef(backend)],
    ]),
  };
}

async function historicalSnapshot(fail: boolean) {
  let host: Host;
  const plugin = definePlugin({
    name: "historical",
    setup() {
      if (fail) throw new Error("historical", { cause: host });
    },
  });
  host = createHost({ resourceAuthority, installations: [{ id: "historical", plugin }] });
  await host.start().catch((error) => {
    if (!fail) throw error;
  });
  const snapshot = host.diagnostics.get();
  await host.stop();
  return { snapshot, reference: new WeakRef(host) };
}

async function abandonedHost() {
  const host = createHost({
    resourceAuthority,
    installations: [{ id: "abandoned", plugin: empty }],
  });
  await host.start();
  return new WeakRef(host);
}

async function terminalView(kind: "diagnostics" | "contributions", afterQuarantine: boolean) {
  const reporter = () => undefined;
  const payload = { starts: 0 };
  const observerPayload = { notifications: 0 };
  const point = extensionPoint<number>("retention/terminal-view");
  const host = createHost({
    resourceAuthority,
    onError: reporter,
    installations: [
      {
        id: "original",
        plugin: definePlugin({
          name: "original",
          setup() {
            if (++payload.starts > 1) throw new Error("Restoration failed");
          },
        }),
      },
    ],
  });
  let view = afterQuarantine
    ? undefined
    : kind === "diagnostics"
      ? host.diagnostics
      : host.contributions(point);
  const subscription = view?.subscribe(() => {
    observerPayload.notifications++;
  });
  await host.start();
  const change = host.change();
  change.update(host.installation("original")!, {
    plugin: definePlugin({
      name: "replacement",
      setup() {
        throw new Error("Replacement failed");
      },
    }),
  });
  const failure = await host.apply(await host.plan(change)).then(
    () => false,
    () => true,
  );
  if (!failure || host.status !== "quarantined" || host.diagnostics.get().unresolved.length) {
    throw new Error("Expected terminal quarantine with completed release obligations");
  }
  view ??= kind === "diagnostics" ? host.diagnostics : host.contributions(point);
  return {
    view,
    subscription,
    references: new Map<string, WeakRef<object>>([
      ["Host facade", new WeakRef(host)],
      ["Engine reporter", new WeakRef(reporter)],
      ["plugin payload", new WeakRef(payload)],
      ["subscriber payload", new WeakRef(observerPayload)],
    ]),
  };
}

async function completedLateRetirement() {
  const reporter = () => undefined;
  const payload = { value: 1 };
  const observerPayload = { notifications: 0 };
  const value = service<object>("retention/late-provider");
  const resume = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let owner!: LifetimeContext;
  let provided!: WeakRef<object>;
  const host = createHost({
    resourceAuthority,
    shutdownTimeoutMilliseconds: 1,
    onError: reporter,
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            owner = lifetime;
            const serviceValue = { payload };
            provided = new WeakRef(serviceValue);
            return { value: serviceValue };
          },
        }),
      },
      {
        id: "consumer",
        plugin: definePlugin({
          name: "consumer",
          requires: { value },
          setup({ lifetime }) {
            lifetime.defer(() => resume.promise);
          },
        }),
      },
    ],
  });
  const view = host.diagnostics;
  const subscription = view.subscribe(() => {
    observerPayload.notifications++;
    if (view.get().status === "quarantined" && view.get().unresolved.length === 0)
      finished.resolve();
  });
  await host.start();
  const failed = await host.stop().then(
    () => false,
    () => true,
  );
  if (!failed || host.status !== "quarantined") throw new Error("Expected shutdown quarantine");
  resume.resolve();
  await finished.promise;
  return {
    view,
    subscription,
    owner,
    references: new Map<string, WeakRef<object>>([
      ["Host facade", new WeakRef(host)],
      ["Engine reporter", new WeakRef(reporter)],
      ["plugin payload", new WeakRef(payload)],
      ["subscriber payload", new WeakRef(observerPayload)],
      ["provided Service", provided],
    ]),
  };
}

function discardedWriter() {
  const registry = new ContractRegistry();
  const writer = registry.writer(new Map());
  writer.discard();
  return { writer, reference: new WeakRef(registry) };
}

async function removedInstallation() {
  const host = createHost({ resourceAuthority, installations: [{ id: "removed", plugin: empty }] });
  const installation = host.installation("removed")!;
  await host.start();
  const change = host.change();
  change.remove(installation);
  await host.apply(await host.plan(change));
  await host.stop();
  return { installation, reference: new WeakRef(host) };
}

async function rejectedCandidate(stack: boolean) {
  const host = createHost({ resourceAuthority });
  await host.start();
  const change = host.change();
  const installation = change.install(
    definePlugin({
      name: "rejected",
      setup() {
        const error = new Error("rejected candidate");
        if (!stack) Object.defineProperty(error, "stack", { value: undefined });
        throw error;
      },
    }),
    { id: "rejected" },
  );
  const error = await host.apply(await host.plan(change)).catch((error) => String(error));
  await host.stop();
  return { installation, error, reference: new WeakRef(host) };
}

async function removedGroup() {
  const host = createHost({
    resourceAuthority,
    groups: [{ id: "parent" }],
    installations: [{ id: "owned", plugin: empty, groupId: "parent" }],
  });
  const group = host.group("parent")!;
  await host.start();
  const change = host.change();
  change.removeGroup(group);
  await host.apply(await host.plan(change));
  await host.stop();
  return { group, reference: new WeakRef(host) };
}

async function lateGroup() {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host = createHost({
    resourceAuthority,
    groups: [{ id: "parent" }],
    installations: [
      {
        id: "owned",
        groupId: "parent",
        plugin: definePlugin({
          name: "late",
          setup({ lifetime }) {
            lifetime.defer(async () => {
              entered.resolve();
              await resume.promise;
            });
          },
        }),
      },
    ],
  });
  const parent = host.group("parent")!;
  await host.start();
  const remove = host.change();
  remove.removeGroup(parent);
  const removal = host.apply(await host.plan(remove));
  await entered.promise;
  const late = host.change();
  const group = late.group("late", parent);
  resume.resolve();
  await removal;
  await expect(host.plan(late)).rejects.toThrow("parent");
  await host.stop();
  return { group, reference: new WeakRef(host) };
}

function unappliedGroup() {
  const host = createHost({ resourceAuthority });
  const change = host.change();
  return { group: change.group("unapplied"), reference: new WeakRef(host) };
}

async function abandonedInstallation(planned: boolean) {
  const onError = () => undefined;
  const host = createHost({ resourceAuthority, onError });
  const change = host.change();
  const installation = change.install(empty, { id: "pending" });
  if (planned) await host.plan(change);
  return { installation, reporter: new WeakRef(onError) };
}

it("keeps stale Plan reports and pending identities without retaining their plugin payload", async () => {
  const host = createHost({ resourceAuthority });
  const { plan, pending, reference } = await retainedCandidate(host);
  // A separate in-flight validation still holds the old base. It does not own other plans.
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const change = host.change();
  change.install(
    definePlugin({
      name: "validating",
      configuration: {
        "~standard": {
          version: 1,
          vendor: "test",
          async validate() {
            entered.resolve();
            await finish.promise;
            return { value: null };
          },
        },
      },
      setup() {},
    }),
    { id: "validating", configuration: null },
  );
  const validation = host.plan(change).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  await host.start();
  try {
    await collect([reference]);
    expect(reference.deref()).toBeUndefined();
  } finally {
    finish.resolve();
    expect(await validation).toMatchObject({ code: "PLAN_STALE" });
  }
  expect(pending.status).toBe("removed");
  expect(plan.report.operations[0]?.id).toBe("candidate");
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_STALE" });
  expect(pending.status).toBe("removed");
  await expect(host.apply(plan)).rejects.toMatchObject({ code: "PLAN_CONSUMED" });
  await host.stop();
});

async function retainedCandidate(host: Host) {
  const payload = { uses: 0 };
  const change = host.change();
  const pending = change.install(
    definePlugin({
      name: "candidate",
      setup() {
        payload.uses++;
      },
    }),
    { id: "candidate" },
  );
  return { plan: await host.plan(change), pending, reference: new WeakRef(payload) };
}

async function terminalHandles() {
  const onError = () => undefined;
  const payload = { calls: 0 };
  const host = createHost({
    resourceAuthority,
    onError,
    installations: [
      {
        id: "owner",
        origin: { revision: "v1" },
        plugin: definePlugin({
          name: "owner",
          setup({ lifetime }) {
            lifetime.defer(() => {
              throw new Error("cleanup failed");
            });
          },
        }),
      },
    ],
  });
  await host.start();
  const owner = host.installation("owner")!;
  const draft = host.change();
  const unresolved = draft.install(
    definePlugin({
      name: "unused",
      setup() {
        payload.calls++;
      },
    }),
    { id: "unused" },
  );
  const failed = await host.stop().then(
    () => false,
    () => true,
  );
  if (!failed || host.status !== "quarantined") throw new Error("Expected terminal quarantine");
  return {
    owner,
    draft,
    unresolved,
    reporter: new WeakRef(onError),
    payload: new WeakRef(payload),
  };
}

it("a quarantined Installation or pre-quarantine draft cannot retain or advance execution", async () => {
  const fixture = await terminalHandles();
  await collect([fixture.reporter, fixture.payload]);
  expect(fixture.reporter.deref()).toBeUndefined();
  expect(fixture.payload.deref()).toBeUndefined();
  expect(fixture.owner.status).toBe("quarantined");
  expect(fixture.owner.origin).toEqual({ revision: "v1" });
  expect(fixture.unresolved.status).toBe("removed");
  expect(() => fixture.draft.group("late")).toThrowError(
    expect.objectContaining({ code: "HOST_QUARANTINED" }),
  );
});

function stalledValidation(entered: () => void, finish: Promise<void>) {
  return definePlugin({
    name: "stalled",
    configuration: {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate() {
          entered();
          await finish;
          return { value: null };
        },
      },
    },
    setup() {},
  });
}

async function obsoleteValidation(finish: Promise<void>) {
  const onError = () => undefined;
  const host = createHost({ resourceAuthority, onError });
  const change = host.change();
  const entered = Promise.withResolvers<void>();
  change.install(stalledValidation(entered.resolve, finish), {
    id: "stalled",
    configuration: null,
  });
  const planning = host.plan(change).then(
    () => "issued",
    (error: unknown) => (error instanceof Error ? error.message : "unknown"),
  );
  await entered.promise;
  await host.start();
  return { planning, reporter: new WeakRef(onError) };
}

it("a stalled validator cannot retain a Host once its revision has ended", async () => {
  const finish = Promise.withResolvers<void>();
  const fixture = await obsoleteValidation(finish.promise);
  try {
    await collect([fixture.reporter]);
    expect(fixture.reporter.deref()).toBeUndefined();
  } finally {
    finish.resolve();
    await fixture.planning;
  }
});
