import { describe, expect, it } from "vitest";
import { ContributionStore } from "../src/contribution-store";

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
  });
});

function createStore<T>() {
  return new ContributionStore<T>(
    () => undefined,
    () => undefined,
    () => undefined,
  );
}
