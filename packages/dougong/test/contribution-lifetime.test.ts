import { describe, expect, it, vi } from "vitest";
import { createResourceAuthority, type Disposable } from "../src";
import { captureResourceAuthority, type Resource } from "../src/contracts/resource";
import { extensionPoint } from "../src/contracts/contracts";
import { ContributionRegistry } from "../src/contributions/contribution-registry";
import { ContributionStore } from "../src/contributions/contribution-store";
import { Lifetime, type ReleaseFailure } from "../src/lifetime/lifetime";

describe.each(["notification", "control registration"] as const)(
  "contribution retention closes during %s",
  (phase) => {
    describe.each(["view", "subscription"] as const)("contribution %s", (kind) => {
      it.each([false, true])(
        "releases one Lifetime record (control registration fails: %s)",
        async (registrationFails) => {
          const authority = createResourceAuthority();
          const claim = vi.fn<(resource: Resource) => () => void>((resource) =>
            authority.claim(resource),
          );
          const failure = new Error("contribution control registration failed");
          const changed = vi.fn<() => void>();
          let armed = false;
          let tracked: Disposable | undefined;
          let closing: Promise<void> | undefined;
          let owner!: Lifetime;
          const root = new Lifetime({
            label: "contribution-retention-owner",
            report() {},
            changed() {
              if (phase === "notification" && armed && !closing) closing = owner.dispose();
            },
            resourceAuthority: captureResourceAuthority({
              claim,
              markControlHandle(handle: object) {
                authority.markControlHandle(handle);
                if (!armed) return;
                tracked = handle as Disposable;
                if (phase === "control registration") tracked[Symbol.dispose]();
                if (registrationFails) throw failure;
              },
            }),
          });
          const child = root.child("consumer");
          owner = root.resolveOwner({ lifetime: child });
          const registry = new ContributionRegistry(() => undefined);
          const point = extensionPoint<number>("contribution-retention/items");
          const store = registry.store<number>(point);
          const hostView = store.hostView();
          const contribution = store.stage("owner/item", 1, root, () => undefined);
          root.publish();
          claim.mockClear();
          armed = true;
          let result: unknown;
          let error: unknown;
          try {
            try {
              result = kind === "view" ? store.view(owner) : store.subscribe(changed, owner);
            } catch (reason) {
              error = reason;
            }
            armed = false;
            await closing;
            expect(error).toBe(registrationFails ? failure : undefined);
            expect(owner.snapshot().cleanups).toBe(0);
            expect(claim).not.toHaveBeenCalled();
            expect(hostView.get()).toEqual(["owner/item"]);
            expect(registry.store(point)).toBe(store);
            contribution.update(2);
            expect(changed).not.toHaveBeenCalled();
            tracked?.[Symbol.dispose]();
            if (kind === "subscription" && result) (result as Disposable)[Symbol.dispose]();
            expect(owner.snapshot().cleanups).toBe(0);
          } finally {
            armed = false;
            await root.dispose();
          }
        },
      );
    });
  },
);

it.each(["Error", "undefined"] as const)(
  "keeps a subscription's failed %s release owned and rethrows its original outcome",
  async (reason) => {
    const authority = createResourceAuthority();
    const claim = vi.fn<(resource: Resource) => () => void>((resource) =>
      authority.claim(resource),
    );
    const failure = reason === "Error" ? new Error("Store release failed") : undefined;
    const releaseFailed = vi.fn<(failure: ReleaseFailure) => void>();
    const controls: Disposable[] = [];
    const owner = new Lifetime({
      label: "failed-contribution-retention",
      report() {},
      releaseFailed,
      resourceAuthority: captureResourceAuthority({
        claim,
        markControlHandle(handle: object) {
          authority.markControlHandle(handle);
          controls.push(handle as Disposable);
        },
      }),
    });
    const release = vi.fn<() => void>(() => {
      throw failure;
    });
    const store = new ContributionStore<number>(
      { invalidate: (current) => current.publishSnapshot(), release },
      () => undefined,
    );
    const view = store.view(owner);
    const subscription = view.subscribe(() => undefined);
    controls[0]![Symbol.dispose]();
    const dispose = () => {
      try {
        subscription[Symbol.dispose]();
      } catch (error) {
        return error;
      }
      throw new Error("Expected subscription disposal to fail");
    };
    try {
      for (const outcome of Array.from({ length: 2 }, dispose)) {
        expect(outcome).toBe(failure);
      }
      expect(release).toHaveBeenCalledOnce();
      expect(releaseFailed).toHaveBeenCalledExactlyOnceWith({
        owner,
        kind: "cleanup",
        error: failure,
      });
      expect(owner.snapshot().cleanups).toBe(1);
      expect(claim).not.toHaveBeenCalled();
    } finally {
      await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] });
    }
    expect(dispose()).toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  },
);
