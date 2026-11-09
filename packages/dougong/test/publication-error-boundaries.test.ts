import { expect, it, vi } from "vitest";
import { createHost, definePlugin, event, extensionPoint, type PluginContext } from "../src";
import { batchSnapshotNotifications, SnapshotPublisher } from "../src/advanced";
import { Lifetime } from "../src/lifetime/lifetime";

function brokenPublisher() {
  const observerFailure = new Error("foreign observer failed");
  const reporterFailure = new Error("foreign error reporter failed");
  const publisher = new SnapshotPublisher(
    () => undefined,
    () => {
      throw reporterFailure;
    },
  );
  publisher.view.subscribe(() => {
    throw observerFailure;
  });
  return { publisher, observerFailure, reporterFailure };
}

async function runningOwner() {
  let context!: PluginContext<{}>;
  const report = vi.fn<(error: unknown) => void>();
  const host = createHost({
    onError: report,
    installations: [
      {
        id: "owner",
        plugin: definePlugin({
          name: "owner",
          setup(current) {
            context = current;
          },
        }),
      },
    ],
  });
  await host.start();
  return { host, context, report };
}

function failureCauses(error: unknown): unknown[] {
  if (error instanceof AggregateError) return [error, ...error.errors.flatMap(failureCauses)];
  if (error instanceof Error && error.cause !== undefined)
    return [error, ...failureCauses(error.cause)];
  return [error];
}

it("delivers the published listener handle while reporting another publisher's notification failure", async () => {
  const { host, context, report } = await runningOwner();
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const diagnostics = host.diagnostics.subscribe(() => publisher.invalidate());
  const notice = event<void>("publication-errors/listener");
  let calls = 0;
  try {
    const listener = context.events.on(notice, () => {
      calls++;
    });
    diagnostics[Symbol.dispose]();
    await context.events.emit(notice);
    listener[Symbol.dispose]();
    await context.events.emit(notice);
    expect(calls).toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ errors: [observerFailure, reporterFailure] }),
    );
  } finally {
    diagnostics[Symbol.dispose]();
    publisher[Symbol.dispose]();
    await host.stop();
  }
});

it("delivers the published contribution handle while reporting another publisher's notification failure", async () => {
  const { host, context, report } = await runningOwner();
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const diagnostics = host.diagnostics.subscribe(() => publisher.invalidate());
  const point = extensionPoint<number>("publication-errors/contribution");
  try {
    const contribution = context.contributions.add(point, "value", 7);
    diagnostics[Symbol.dispose]();
    const view = host.contributions(point);
    expect(view.get()).toEqual(["owner/value"]);
    expect(await view.use("owner/value", (value) => value)).toEqual({ value: 7 });
    contribution.update(8);
    expect(await view.use("owner/value", (value) => value)).toEqual({ value: 8 });
    contribution[Symbol.dispose]();
    expect(view.get()).toEqual([]);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ errors: [observerFailure, reporterFailure] }),
    );
  } finally {
    diagnostics[Symbol.dispose]();
    publisher[Symbol.dispose]();
    await host.stop();
  }
});

it("does not turn completed child withdrawal into permanent parent retention through another publisher", async () => {
  const { host, context, report } = await runningOwner();
  const child = context.lifetime.child("published-child");
  let parentReleased = false;
  let childReleased = false;
  context.lifetime.defer(() => {
    parentReleased = true;
  });
  child.defer(() => {
    childReleased = true;
  });
  context.contributions.add(
    extensionPoint<number>("publication-errors/child-withdrawal"),
    "value",
    1,
    { lifetime: child },
  );
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const diagnostics = host.diagnostics.subscribe(() => publisher.invalidate());
  const childOutcome = await child[Symbol.asyncDispose]().then(
    () => "fulfilled",
    () => "rejected",
  );
  diagnostics[Symbol.dispose]();
  publisher[Symbol.dispose]();
  const stopOutcome = await host.stop().then(
    () => "fulfilled",
    () => "rejected",
  );
  expect({ childOutcome, childReleased, stopOutcome, parentReleased, status: host.status }).toEqual(
    {
      childOutcome: "fulfilled",
      childReleased: true,
      stopOutcome: "fulfilled",
      parentReleased: true,
      status: "stopped",
    },
  );
  expect(report.mock.calls.flatMap(([error]) => failureCauses(error))).toEqual(
    expect.arrayContaining([observerFailure, reporterFailure]),
  );
});

it.each(["child", "host"] as const)(
  "reports notification failures entered directly by an abort listener during %s shutdown",
  async (operation) => {
    const { host, context, report } = await runningOwner();
    const child = context.lifetime.child("cancellation-source");
    const releaseChild = vi.fn<() => void>();
    child.defer(releaseChild);
    const { publisher, observerFailure, reporterFailure } = brokenPublisher();
    child.signal.addEventListener("abort", () => publisher.invalidate());
    try {
      await (operation === "child" ? child[Symbol.asyncDispose]() : host.stop());
      expect(releaseChild).toHaveBeenCalledOnce();
      expect(host.status).toBe(operation === "child" ? "running" : "stopped");
      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errors: [observerFailure, reporterFailure] }),
      );
    } finally {
      publisher[Symbol.dispose]();
      await host.stop();
    }
  },
);

it("retains real failed child cleanup while reporting unrelated notification failures separately", async () => {
  const { host, context, report } = await runningOwner();
  const parentReleased = vi.fn<() => void>();
  context.lifetime.defer(parentReleased);
  const child = context.lifetime.child("failed-child");
  const cleanupFailure = new Error("child resource is still owned");
  const releaseChild = vi.fn<() => never>(() => {
    throw cleanupFailure;
  });
  child.defer(releaseChild);
  context.contributions.add(extensionPoint<number>("publication-errors/failed-child"), "value", 1, {
    lifetime: child,
  });
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const diagnostics = host.diagnostics.subscribe(() => publisher.invalidate());
  const failure = await child[Symbol.asyncDispose]().catch((error: unknown) => error);
  diagnostics[Symbol.dispose]();
  publisher[Symbol.dispose]();
  await vi.waitFor(() =>
    expect(host.diagnostics.get().unresolved[0]?.lifetime.phase).toBe("quarantined"),
  );

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([cleanupFailure]);
  expect(host.status).toBe("quarantined");
  expect(parentReleased).not.toHaveBeenCalled();
  await expect(child[Symbol.asyncDispose]()).rejects.toBe(failure);
  await expect(host.stop()).rejects.toMatchObject({ code: "HOST_QUARANTINED" });
  expect(releaseChild).toHaveBeenCalledOnce();
  expect(host.diagnostics.get().unresolved[0]?.lifetime.children[0]).toMatchObject({
    phase: "quarantined",
    cleanups: 1,
    unresolved: [{ kind: "cleanup", error: { message: cleanupFailure.message } }],
  });
  expect(report.mock.calls.flatMap(([error]) => failureCauses(error))).toEqual(
    expect.arrayContaining([cleanupFailure, observerFailure, reporterFailure]),
  );
});

it("preserves a failed publication withdrawal and its parent resources without mixing notification errors", async () => {
  const report = vi.fn<(error: unknown) => void>();
  using diagnostics = new SnapshotPublisher(() => undefined, report);
  const root = new Lifetime({
    label: "publication-owner",
    report,
    changed: () => batchSnapshotNotifications(() => diagnostics.invalidate(), report),
  });
  const child = root.resolveOwner({ lifetime: root.child("child") });
  const parentReleased = vi.fn<() => void>();
  root.defer(parentReleased);
  const withdrawalFailure = new Error("publication is still owned");
  const withdraw = vi.fn<() => never>(() => {
    throw withdrawalFailure;
  });
  child.stage((detach) => ({
    publish() {},
    [Symbol.dispose]() {
      detach();
      withdraw();
    },
  }));
  root.publish();
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const subscription = diagnostics.view.subscribe(() => publisher.invalidate());
  const failure = await root.dispose().catch((error: unknown) => error);
  subscription[Symbol.dispose]();
  publisher[Symbol.dispose]();

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0].errors).toEqual([withdrawalFailure]);
  expect(parentReleased).not.toHaveBeenCalled();
  expect(root.snapshot().children[0]).toMatchObject({
    phase: "quarantined",
    publications: 1,
    unresolved: [{ kind: "publication", error: { message: withdrawalFailure.message } }],
  });
  await expect(root.dispose()).rejects.toBe(failure);
  expect(withdraw).toHaveBeenCalledOnce();
  expect(report.mock.calls.flatMap(([error]) => failureCauses(error))).toEqual(
    expect.arrayContaining([observerFailure, reporterFailure]),
  );
});

it("keeps a real Event listener failure on the foreground receipt while reporting notification failures", async () => {
  const { host, context, report } = await runningOwner();
  const notice = event<void>("publication-errors/foreground");
  const listenerFailure = new Error("event listener failed");
  context.events.on(notice, () => {
    throw listenerFailure;
  });
  const { publisher, observerFailure, reporterFailure } = brokenPublisher();
  const diagnostics = host.diagnostics.subscribe(() => publisher.invalidate());
  const failure = await context.events.emit(notice).catch((error: unknown) => error);
  diagnostics[Symbol.dispose]();
  publisher[Symbol.dispose]();
  try {
    expect(failure).toMatchObject({ errors: [listenerFailure] });
    expect(host.status).toBe("running");
    const reported = report.mock.calls.flatMap(([error]) => failureCauses(error));
    expect(reported).toEqual(expect.arrayContaining([observerFailure, reporterFailure]));
    expect(reported).not.toContain(listenerFailure);
  } finally {
    await host.stop();
  }
});
