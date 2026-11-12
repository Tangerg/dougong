import { expect, it, vi } from "vitest";
import { createResourceAuthority, type Contribution } from "../src";
import { captureResourceAuthority, type Resource } from "../src/contracts/resource";
import { ContributionRegistry } from "../src/contributions/contribution-registry";
import { extensionPoint } from "../src/contracts/contracts";
import { EventHub } from "../src/events/event-hub";
import { Lifetime, type ReleaseFailure } from "../src/lifetime/lifetime";

function fixture() {
  const authority = createResourceAuthority();
  const releaseFailed = vi.fn<(failure: ReleaseFailure) => void>();
  let marking: (() => void) | undefined;
  const root = new Lifetime({
    label: "publication-owner",
    report() {},
    releaseFailed,
    resourceAuthority: captureResourceAuthority({
      claim: (resource: Resource) => authority.claim(resource),
      markControlHandle(handle: object) {
        authority.markControlHandle(handle);
        marking?.();
      },
    }),
  });
  const handle = root.child("child");
  const child = root.resolveOwner({ lifetime: handle });
  const hub = new EventHub();
  const registry = new ContributionRegistry(() => undefined);
  const point = extensionPoint<number>("publication-registration/items");
  const store = registry.store<number>(point);
  const view = store.hostView();
  root.publish();
  return {
    root,
    child,
    hub,
    store,
    view,
    releaseFailed,
    onMark: (callback: () => void) => (marking = callback),
  };
}

it.each(["listener", "contribution"] as const)(
  "keeps early %s withdrawal failures under the same Lifetime authority",
  async (kind) => {
    const { root, child, hub, store, releaseFailed } = fixture();
    const failure = new Error("publication could not be withdrawn");
    const withdraw =
      kind === "listener"
        ? vi.spyOn(hub, "delete").mockImplementation(() => {
            throw failure;
          })
        : vi.spyOn(store, "removeContribution").mockImplementation(() => {
            throw failure;
          });
    const handle =
      kind === "listener"
        ? hub.stage("notice", () => undefined, child)
        : store.stage("owner/item", 1, child, () => undefined);
    expect(() => handle[Symbol.dispose]()).toThrow(failure);
    expect(() => handle[Symbol.dispose]()).toThrow(failure);
    expect(child.snapshot()).toMatchObject({
      publications: 1,
      unresolved: [{ kind: "publication", error: { message: failure.message } }],
    });
    expect(releaseFailed).toHaveBeenCalledExactlyOnceWith({
      owner: child,
      kind: "publication",
      error: failure,
    });
    await expect(root.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(withdraw).toHaveBeenCalledOnce();
  },
);

it.each(["listener", "contribution"] as const)(
  "registers a %s before authority callbacks can close its owner",
  async (kind) => {
    const { root, child, hub, store, view, onMark } = fixture();
    let closing!: Promise<void>;
    onMark(() => {
      closing = child.dispose();
    });
    if (kind === "listener") hub.stage("notice", () => undefined, child);
    else store.stage("owner/item", 1, child, () => undefined);
    await closing;
    expect(child.snapshot()).toMatchObject({ phase: "disposed", publications: 0 });
    expect(view.get()).toEqual([]);
    await root.dispose();
  },
);

it.each(["listener", "contribution"] as const)(
  "withdraws a %s whose control registration fails",
  async (kind) => {
    const { root, child, hub, store, view, onMark } = fixture();
    const failure = new Error("control registration failed");
    onMark(() => {
      throw failure;
    });
    const register = () =>
      kind === "listener"
        ? hub.stage("notice", () => undefined, child)
        : store.stage("owner/item", 1, child, () => undefined);
    expect(register).toThrow(failure);
    expect(child.snapshot().publications).toBe(0);
    expect(view.get()).toEqual([]);
    await root.dispose();
  },
);

it("reserves a contribution identity before control registration can reenter it", async () => {
  const { root, child, store, view, onMark } = fixture();
  const reenter = vi.fn<() => Contribution<number>>(() =>
    store.stage("owner/item", 2, child, () => undefined),
  );
  onMark(() => {
    onMark(() => undefined);
    expect(reenter).toThrow("Duplicate contribution");
  });
  store.stage("owner/item", 1, child, () => undefined);
  expect(await view.use("owner/item", (value) => value)).toEqual({ value: 1 });
  await root.dispose();
});

it("joins a completed withdrawal when control registration closes its owner and then fails", async () => {
  const { root, child, onMark } = fixture();
  const failure = new Error("registration failed after shutdown");
  const withdraw = vi.fn<() => void>();
  let closing!: Promise<void>;
  onMark(() => {
    closing = child.dispose();
    throw failure;
  });
  expect(() =>
    child.stage(() => ({ handle: Object.freeze({}), publish() {}, [Symbol.dispose]: withdraw })),
  ).toThrow(failure);
  await closing;
  expect(withdraw).toHaveBeenCalledOnce();
  expect(child.snapshot().publications).toBe(0);
  await root.dispose();
});

it("retains a failed registration rollback as one publication obligation", async () => {
  const { root, child, onMark } = fixture();
  const registrationFailure = new Error("registration failed");
  const withdrawalFailure = new Error("withdrawal failed");
  const withdraw = vi.fn<() => never>(() => {
    throw withdrawalFailure;
  });
  onMark(() => {
    throw registrationFailure;
  });
  expect(() =>
    child.stage(() => ({
      handle: Object.freeze({}),
      publish() {},
      [Symbol.dispose]() {
        withdraw();
      },
    })),
  ).toThrow(expect.objectContaining({ errors: [registrationFailure, withdrawalFailure] }));
  expect(child.snapshot()).toMatchObject({
    publications: 1,
    unresolved: [{ kind: "publication", error: { message: withdrawalFailure.message } }],
  });
  await expect(root.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(withdraw).toHaveBeenCalledOnce();
});
