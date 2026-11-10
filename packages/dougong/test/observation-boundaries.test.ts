import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin } from "../src/index";
import { SnapshotPublisher } from "../src/advanced";

const resourceAuthority = createResourceAuthority();

it.each(["start", "apply", "stop"] as const)(
  "reports foreign observation failures without rejecting a committed Host %s",
  async (operation) => {
    const observerFailure = new Error("external observer failed");
    const reporterFailure = new Error("external reporter failed");
    using publisher = new SnapshotPublisher(
      () => 1,
      () => {
        throw reporterFailure;
      },
    );
    using _externalSubscription = publisher.view.subscribe(() => {
      throw observerFailure;
    });
    const report = vi.fn<(error: unknown) => void>();
    const host = createHost({ resourceAuthority, onError: report });
    if (operation !== "start") await host.start();
    const previousRevision = host.stateRevision;
    let change: Promise<unknown>;
    const targetStatus = operation === "stop" ? "stopped" : "running";
    let observed = false;
    using _diagnosticsSubscription = host.diagnostics.subscribe(() => {
      if (!observed && host.status === targetStatus && host.stateRevision > previousRevision) {
        observed = true;
        publisher.invalidate();
      }
    });
    if (operation === "apply") {
      const draft = host.change();
      draft.install(definePlugin({ name: "candidate", setup() {} }), { id: "candidate" });
      change = host.apply(await host.plan(draft));
    } else change = host[operation]();
    const outcome = await change.then(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    expect(host.status).toBe(targetStatus);
    expect(host.stateRevision).toBe(previousRevision + 1);
    await host.stop();
    expect(outcome.status).toBe("fulfilled");
    expect(observed).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    const failure = report.mock.calls[0]![0];
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toBe(observerFailure);
    expect((failure as AggregateError).errors[1]).toBe(reporterFailure);
  },
);

it("preserves the failed-and-restored outcome while separately reporting observation failures", async () => {
  const setupFailure = new Error("candidate failed");
  const observerFailure = new Error("observer failed");
  const reporterFailure = new Error("reporter failed");
  const report = vi.fn<(error: unknown) => void>();
  using publisher = new SnapshotPublisher(
    () => 1,
    () => {
      throw reporterFailure;
    },
  );
  using _externalSubscription = publisher.view.subscribe(() => {
    throw observerFailure;
  });
  const original = definePlugin({ name: "original", setup() {} });
  const host = createHost({
    resourceAuthority,
    onError: report,
    installations: [{ id: "target", plugin: original }],
  });
  await host.start();
  const before = host.stateRevision;
  let observed = false;
  using _diagnosticsSubscription = host.diagnostics.subscribe(() => {
    if (!observed && host.status === "running" && host.stateRevision > before) {
      observed = true;
      publisher.invalidate();
    }
  });
  const draft = host.change();
  draft.update(host.installation("target")!, {
    plugin: definePlugin({
      name: "broken",
      setup() {
        throw setupFailure;
      },
    }),
  });
  const error = await host.apply(await host.plan(draft)).catch((failure: unknown) => failure);
  expect(host.status).toBe("running");
  expect(host.stateRevision).toBe(before + 1);
  await host.stop();
  expect(error).toMatchObject({
    code: "TRANSITION_FAILED",
    details: { outcome: "restored" },
    cause: setupFailure,
  });
  expect(observed).toBe(true);
  expect(report).toHaveBeenCalledOnce();
  const failure = report.mock.calls[0]![0];
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect((failure as AggregateError).errors[0]).toBe(observerFailure);
  expect((failure as AggregateError).errors[1]).toBe(reporterFailure);
});
