import { describe, expect, it } from "vitest";
import { extensionPoint } from "../src";
import { ContributionRegistry, ContributionStore } from "../src/contribution-store";

describe("ContributionStore invariants", () => {
  it("distinguishes a duplicate declaration from invalid publication state", () => {
    const store = createStore<number>();
    const claimed = store.stage("owner", "item", 1, () => undefined);

    expect(() => store.stage("owner", "item", 2, () => undefined)).toThrowError(
      new TypeError("Duplicate contribution 'owner/item'"),
    );

    const foreign = createStore<number>().stage("owner", "item", 2, () => undefined);
    expect(() => store.insert("owner/item", foreign, 2)).toThrowError(
      new Error("Contribution 'owner/item' is not the current claim"),
    );

    claimed.publish();
    expect(() => store.insert("owner/item", claimed, 1)).toThrowError(
      new Error("Contribution 'owner/item' is already published"),
    );
    expect(() => store.update("owner/item", foreign, 2)).toThrowError(
      new Error("Contribution 'owner/item' is not the published entry"),
    );
    expect(() => store.removeContribution("owner/item", foreign, "published")).toThrowError(
      new Error("Contribution 'owner/item' is not the current claim"),
    );
  });

  it("leaves the claim intact when removal validation fails", () => {
    const store = createStore<number>();
    const contribution = store.stage("owner", "item", 1, () => undefined);

    expect(() => store.removeContribution("owner/item", contribution, "published")).toThrowError(
      new Error("Contribution 'owner/item' is not the published entry"),
    );

    contribution.publish();
    expect(store.snapshot().get("owner/item")).toBe(1);
  });

  it("keeps duplicate listener functions as independent subscriptions", () => {
    const store = createStore<number>();
    const contribution = store.stage("owner", "item", 1, () => undefined);
    let notifications = 0;
    const listener = () => notifications++;
    const own = () => () => undefined;
    const first = store.subscribe(listener, own);
    const second = store.subscribe(listener, own);

    contribution.publish();
    expect(notifications).toBe(2);

    first.dispose();
    contribution.handle.update(2);
    expect(notifications).toBe(3);

    second.dispose();
    contribution.handle.update(3);
    expect(notifications).toBe(3);
    contribution.handle.dispose();
  });

  it("commits publication state before notifying reentrant subscribers", () => {
    let releases = 0;
    const store = new ContributionStore<number>(
      (current) => current.publishSnapshot(),
      () => undefined,
      () => releases++,
    );
    const contribution = store.stage("owner", "item", 1, () => undefined);
    let subscription!: { dispose(): void | Promise<void> };
    subscription = store.subscribe(
      () => {
        contribution.handle.dispose();
        subscription.dispose();
      },
      () => () => undefined,
    );

    contribution.publish();

    expect(store.snapshot().size).toBe(0);
    expect(releases).toBe(1);
    subscription.dispose();
    expect(releases).toBe(1);
  });

  it("keeps publication committed when error reporting fails", () => {
    const subscriberFailure = new Error("subscriber failed");
    const reporterFailure = new Error("reporter failed");
    const store = new ContributionStore<number>(
      (current) => current.publishSnapshot(),
      () => {
        throw reporterFailure;
      },
      () => undefined,
    );
    const contribution = store.stage("owner", "item", 1, () => undefined);
    const subscription = store.subscribe(
      () => {
        throw subscriberFailure;
      },
      () => () => undefined,
    );

    expect(() => contribution.publish()).toThrow(AggregateError);
    subscription.dispose();
    contribution.handle.update(2);

    expect(store.snapshot().get("owner/item")).toBe(2);
    contribution.handle.dispose();
  });

  it("publishes every invalidated Store before surfacing batch reporting failures", () => {
    const registry = new ContributionRegistry(() => {
      throw new Error("reporter failed");
    });
    const firstStore = registry.get(extensionPoint<number>("contribution/batch-first"));
    const secondStore = registry.get(extensionPoint<number>("contribution/batch-second"));
    firstStore.subscribe(
      () => {
        throw new Error("first subscriber failed");
      },
      () => () => undefined,
    );
    secondStore.subscribe(
      () => {
        throw new Error("second subscriber failed");
      },
      () => () => undefined,
    );
    const first = firstStore.stage("owner", "item", 1, () => undefined);
    const second = secondStore.stage("owner", "item", 2, () => undefined);

    registry.beginBatch();
    first.publish();
    second.publish();

    expect(() => registry.endBatch()).toThrow(AggregateError);
    expect(firstStore.snapshot().get("owner/item")).toBe(1);
    expect(secondStore.snapshot().get("owner/item")).toBe(2);
  });
});

function createStore<T>() {
  return new ContributionStore<T>(
    (store) => store.publishSnapshot(),
    () => undefined,
    () => undefined,
  );
}
