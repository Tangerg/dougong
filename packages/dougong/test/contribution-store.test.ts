import { describe, expect, it, vi } from "vitest";
import { extensionPoint } from "../src/contracts/contracts";
import { ContributionRegistry, ContributionStore } from "../src/contributions/contribution-store";
import { Lifetime } from "../src/lifetime/lifetime";
import type { Disposable } from "../src/contracts/resource";

const owner = () => new Lifetime({ label: "owner", report: () => undefined });

function createStore<T>() {
  return new ContributionStore<T>(
    (store) => store.publishSnapshot(),
    () => undefined,
    () => undefined,
  );
}

function captureFailure(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("ContributionStore invariants", () => {
  it("rejects duplicate and foreign claims without disturbing the owner", async () => {
    const store = createStore<number>();
    const lifetime = owner();
    store.stage("owner", "item", 1, lifetime);
    expect(() => store.stage("owner", "item", 2, lifetime)).toThrow(
      "Duplicate contribution 'owner/item'",
    );
    const foreign = createStore<number>().stage("other", "item", 2, lifetime);
    expect(() => store.publishClaim("owner/item", foreign as never)).toThrow(
      "not the current claim",
    );
    lifetime.publish();
    expect(() => store.valueChanged("owner/item", foreign as never)).toThrow(
      "not the current claim",
    );
    expect(() => store.removeContribution("owner/item", foreign as never)).toThrow(
      "not the current claim",
    );
    expect((await store.use("owner/item", (value) => value)).value).toBe(1);
    await lifetime.dispose();
  });

  it("projects only published claims and reads each value from its record", async () => {
    const store = createStore<number>();
    const lifetime = owner();
    const contribution = store.stage("owner", "item", 1, lifetime);
    contribution.update(2);
    expect(store.snapshot().length).toBe(0);
    lifetime.publish();
    expect((await store.use("owner/item", (value) => value)).value).toBe(2);
    contribution.update(1);
    expect((await store.use("owner/item", (value) => value)).value).toBe(1);
    lifetime.publish();
    expect((await store.use("owner/item", (value) => value)).value).toBe(1);
    await lifetime.dispose();
  });

  it("keeps duplicate listener functions as independent subscriptions", async () => {
    const store = createStore<number>();
    const lifetime = owner();
    const contribution = store.stage("owner", "item", 1, lifetime);
    let notifications = 0;
    const listener = () => {
      notifications++;
    };
    const own = () => () => undefined;
    const first = store.subscribe(listener, own);
    const second = store.subscribe(listener, own);
    lifetime.publish();
    expect(notifications).toBe(2);
    first[Symbol.dispose]();
    contribution.update(2);
    expect(notifications).toBe(3);
    second[Symbol.dispose]();
    contribution.update(3);
    expect(notifications).toBe(3);
    await lifetime.dispose();
  });

  it("commits publication state before notifying reentrant subscribers", async () => {
    let releases = 0;
    const store = new ContributionStore<number>(
      (current) => current.publishSnapshot(),
      () => undefined,
      () => {
        releases++;
      },
    );
    const lifetime = owner();
    const contribution = store.stage("owner", "item", 1, lifetime);
    let subscription!: Disposable;
    subscription = store.subscribe(
      () => {
        contribution[Symbol.dispose]();
        subscription[Symbol.dispose]();
      },
      () => () => undefined,
    );
    lifetime.publish();
    expect(store.snapshot().length).toBe(0);
    expect(releases).toBe(1);
    subscription[Symbol.dispose]();
    expect(releases).toBe(1);
    await lifetime.dispose();
  });

  it("keeps publication committed and escalates a failed notification boundary once", async () => {
    const terminalReports: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      terminalReports.push(callback);
    });
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const report = vi.fn<(error: unknown) => never>(() => {
      throw reporterFailure;
    });
    const store = new ContributionStore<number>(
      (current) => current.publishSnapshot(),
      report,
      () => undefined,
    );
    const lifetime = owner();
    const contribution = store.stage("owner", "item", 1, lifetime);
    const subscription = store.subscribe(
      () => {
        throw subscriberFailure;
      },
      () => () => undefined,
    );
    lifetime.publish();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, subscriberFailure);
    expect(report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ errors: [subscriberFailure, reporterFailure] }),
    );
    expect(terminalReports).toHaveLength(1);
    expect(captureFailure(terminalReports[0]!)).toMatchObject({
      errors: [
        expect.objectContaining({ errors: [subscriberFailure, reporterFailure] }),
        reporterFailure,
      ],
    });
    subscription[Symbol.dispose]();
    contribution.update(2);
    expect((await store.use("owner/item", (value) => value)).value).toBe(2);
    await lifetime.dispose();
  });

  it("publishes every invalidated Store before escalating its notification failures", async () => {
    const terminalReports: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      terminalReports.push(callback);
    });
    const firstFailure = new Error("first subscriber failed");
    const secondFailure = new Error("second subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const report = vi.fn<(error: unknown) => never>(() => {
      throw reporterFailure;
    });
    const registry = new ContributionRegistry(report);
    const firstStore = registry.get<number>(extensionPoint("contribution/batch-first"));
    const secondStore = registry.get<number>(extensionPoint("contribution/batch-second"));
    const lifetime = owner();
    const firstSubscription = firstStore.subscribe(
      () => {
        throw firstFailure;
      },
      () => () => undefined,
    );
    const secondSubscription = secondStore.subscribe(
      () => {
        throw secondFailure;
      },
      () => () => undefined,
    );
    firstStore.stage("owner", "item", 1, lifetime);
    secondStore.stage("owner", "item", 2, lifetime);
    registry.beginBatch();
    lifetime.publish();
    registry.endBatch();
    expect((await firstStore.use("owner/item", (value) => value)).value).toBe(1);
    expect((await secondStore.use("owner/item", (value) => value)).value).toBe(2);
    expect(report).toHaveBeenCalledTimes(4);
    expect(terminalReports).toHaveLength(2);
    expect(terminalReports.map(captureFailure)).toMatchObject([
      {
        errors: [
          expect.objectContaining({ errors: [firstFailure, reporterFailure] }),
          reporterFailure,
        ],
      },
      {
        errors: [
          expect.objectContaining({ errors: [secondFailure, reporterFailure] }),
          reporterFailure,
        ],
      },
    ]);
    firstSubscription[Symbol.dispose]();
    secondSubscription[Symbol.dispose]();
    await lifetime.dispose();
  });

  it("publishes changed iteration order even when each key keeps its value", async () => {
    const registry = new ContributionRegistry(() => undefined);
    const store = registry.get<number>(extensionPoint("contribution/reordered"));
    const lifetime = owner();
    const view = store.hostView();
    const first = store.stage("owner", "first", 1, lifetime);
    store.stage("owner", "second", 2, lifetime);
    lifetime.publish();
    const before = view.get();
    const seen: string[][] = [];
    const subscription = view.subscribe(() => {
      seen.push([...view.get()]);
    });
    registry.beginBatch();
    first[Symbol.dispose]();
    store.stage("owner", "first", 1, lifetime);
    registry.endBatch();
    expect([...view.get()]).toEqual(["owner/second", "owner/first"]);
    expect(view.get()).not.toBe(before);
    expect(seen).toEqual([["owner/second", "owner/first"]]);
    subscription[Symbol.dispose]();
    await lifetime.dispose();
  });

  it("releases a Store whose only claim was rejected and keeps one with a claim", async () => {
    const registry = new ContributionRegistry(() => undefined);
    const rejected = extensionPoint<number>("contribution/rejected");
    const claimed = extensionPoint<number>("contribution/claimed");
    const lifetime = owner();
    const unused = registry.get(rejected);
    expect(() => unused.stage("owner", "  ", 1, lifetime)).toThrow(TypeError);
    expect(registry.get(rejected)).not.toBe(unused);
    const held = registry.get(claimed);
    const claim = held.stage("owner", "item", 1, lifetime);
    expect(() => held.stage("owner", "item", 2, lifetime)).toThrow(TypeError);
    expect(registry.get(claimed)).toBe(held);
    claim[Symbol.dispose]();
    expect(registry.get(claimed)).not.toBe(held);
    await lifetime.dispose();
  });

  it("releases its notification reporter when its last view is sealed", async () => {
    function createRetainedStore() {
      const reporter = { report() {} };
      const store = new ContributionStore<number>(
        (current) => current.publishSnapshot(),
        reporter.report.bind(reporter),
        () => undefined,
      );
      const view = store.hostView();
      store.sealHostView();
      return { store, view, reporter: new WeakRef(reporter) };
    }

    const retained = createRetainedStore();
    const collectionPasses = 8;
    for (let pass = 0; pass < collectionPasses && retained.reporter.deref(); pass++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      globalThis.gc!();
    }
    expect(retained.reporter.deref()).toBeUndefined();
    expect(retained.store.snapshot()).toEqual([]);
    expect(retained.view.get()).toEqual([]);
  });
});
