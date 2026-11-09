import { expect, it, vi } from "vitest";
import { createHost } from "dougong";
import { SnapshotPublisher } from "dougong/advanced";
import { createPlatform, MemoryLoader } from "../src";
import { add, deferred, emptyPlugin, nextTurn, select } from "./fixtures";

it.each(["select", "activate", "dispose"] as const)(
  "does not reject a committed Platform %s when another snapshot reporter fails",
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
    const host = createHost();
    const platform = createPlatform({
      id: "notifications",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["sample", { default: emptyPlugin("sample") }]])),
      logger: { debug() {}, info() {}, warn() {}, error: report },
    });
    const artifact = add(platform, "sample", "sample");
    const registration =
      operation === "select" ? undefined : (await platform.select([artifact]))[0];
    if (operation === "dispose") await platform.activate([registration!]);
    let observed = false;
    const subscription = platform.diagnostics.subscribe(() => {
      const snapshot = platform.diagnostics.get();
      const status = snapshot.registrations.get("sample")?.status;
      if (
        !observed &&
        ((operation === "select" && status === "selected") ||
          (operation === "activate" && status === "installed") ||
          (operation === "dispose" && snapshot.status === "disposed"))
      ) {
        observed = true;
        publisher.invalidate();
      }
    });
    let outcome: string;
    try {
      await (operation === "select"
        ? platform.select([artifact])
        : operation === "activate"
          ? platform.activate([registration!])
          : platform[Symbol.asyncDispose]());
      outcome = "fulfilled";
    } catch {
      outcome = "rejected";
    }
    subscription[Symbol.dispose]();
    const committed =
      operation === "select"
        ? platform.registrations()[0]?.selectedArtifact === artifact
        : operation === "activate"
          ? registration!.status === "installed" &&
            host.installation(registration!.id) !== undefined
          : platform.status === "disposed" && host.installation(registration!.id) === undefined;
    await platform[Symbol.asyncDispose]();
    await host.stop();
    expect(observed).toBe(true);
    expect(committed).toBe(true);
    expect(outcome).toBe("fulfilled");
    expect(report).toHaveBeenCalledOnce();
    const failure = report.mock.calls[0]![0];
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toBe(observerFailure);
    expect((failure as AggregateError).errors[1]).toBe(reporterFailure);
  },
);

it.each(["after activation", "during notification"] as const)(
  "finishes activation ownership when observer reporting fails and disposal starts %s",
  async (disposalTiming) => {
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
    const platform = createPlatform({
      id: "notifications",
      host: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["sample", { default: emptyPlugin("sample") }]])),
      logger: { debug() {}, info() {}, warn() {}, error: report },
    });
    const registration = await select(platform, "sample", "sample");
    let observed = false;
    let disposing: Promise<void> | undefined;
    const subscription = platform.diagnostics.subscribe(() => {
      if (!observed && registration.status === "activating") {
        observed = true;
        if (disposalTiming === "during notification") disposing = platform[Symbol.asyncDispose]();
        publisher.invalidate();
      }
    });
    const outcome = await platform.activate([registration]).then(
      () => "fulfilled",
      () => "rejected",
    );
    subscription[Symbol.dispose]();
    const registrationStatus = registration.status;
    const disposal = await Promise.race([
      (disposing ?? platform[Symbol.asyncDispose]()).then(() => "settled"),
      nextTurn().then(() => "unfinished"),
    ]);
    expect(observed).toBe(true);
    expect({ disposal, status: platform.status }).toEqual({
      disposal: "settled",
      status: "disposed",
    });
    const activationSettled =
      outcome === "fulfilled"
        ? registrationStatus === "installed"
        : registrationStatus !== "activating";
    expect(activationSettled).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    const failure = report.mock.calls[0]![0];
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toBe(observerFailure);
    expect((failure as AggregateError).errors[1]).toBe(reporterFailure);
  },
);

it("reports notifications queued by cancelled loader callbacks without rejecting the new selection", async () => {
  const observerFailure = new Error("cancel observer failed");
  const reporterFailure = new Error("cancel reporter failed");
  using publisher = new SnapshotPublisher(
    () => 1,
    () => {
      throw reporterFailure;
    },
  );
  using _subscription = publisher.view.subscribe(() => {
    throw observerFailure;
  });
  const report = vi.fn<(error: unknown) => void>();
  const entered = deferred();
  const resume = deferred<{ default: ReturnType<typeof emptyPlugin> }>();
  const platform = createPlatform({
    id: "cancel-notifications",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: {
      load(_reference: string, signal: AbortSignal) {
        signal.addEventListener("abort", () => publisher.invalidate(), { once: true });
        entered.resolve();
        return resume.promise;
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error: report },
  });
  const registration = await select(platform, "sample", "initial");
  const activation = platform.activate([registration]).catch((error: unknown) => error);
  await entered.promise;
  try {
    const replacement = add(platform, "sample", "replacement", "2.0.0");
    expect(await platform.select([replacement])).toEqual([registration]);
    expect(registration.selectedArtifact).toBe(replacement);
    expect(await activation).toMatchObject({ code: "SELECTION_SUPERSEDED" });
    expect(report).toHaveBeenCalledOnce();
    const failure = report.mock.calls[0]![0];
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toBe(observerFailure);
    expect((failure as AggregateError).errors[1]).toBe(reporterFailure);
  } finally {
    resume.resolve({ default: emptyPlugin("sample") });
    await activation;
    await platform[Symbol.asyncDispose]();
  }
});
