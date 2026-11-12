import { getEventListeners } from "node:events";
import { createHost, createResourceAuthority } from "dougong";
import { expect, it, vi } from "vitest";
import { createPlatform } from "../src";
import { emptyPlugin, nextTurn, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();

function cancellationSignal(kind: "timeout" | "composite") {
  return kind === "timeout"
    ? AbortSignal.timeout(60_000)
    : AbortSignal.any([new AbortController().signal]);
}

it.each(["timeout", "composite"] as const)(
  "owns activation before %s cancellation attachment can reenter disposal",
  async (kind) => {
    const host = createHost({ resourceAuthority });
    const module = { default: emptyPlugin("sample") };
    const loading = Promise.withResolvers<typeof module>();
    const load = vi.fn<() => Promise<typeof module>>(() => loading.promise);
    const platform = createPlatform({
      id: "reentrant-operation-admission",
      host,
      apiVersion: "1.0.0",
      loader: { load },
    });
    const registration = await select(platform, "sample", "one");
    const signal = cancellationSignal(kind);
    let disposeOnAttachment = false;
    let disposing: Promise<void> | undefined;
    const disposingStatuses: string[] = [];
    const subscription = platform.diagnostics.subscribe(() => {
      if (platform.status === "disposing") disposingStatuses.push(registration.status);
    });
    Object.defineProperty(signal, "aborted", {
      get() {
        if (disposeOnAttachment) {
          disposeOnAttachment = false;
          disposing = platform[Symbol.asyncDispose]();
        }
        return Reflect.get(AbortSignal.prototype, "aborted", signal);
      },
    });
    const activation = platform.activate([registration], { signal });
    const outcome = activation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    disposeOnAttachment = true;
    try {
      const result = await Promise.race([
        outcome,
        nextTurn().then(() => ({ status: "pending" as const })),
      ]);
      expect(result).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
      expect(load).not.toHaveBeenCalled();
      expect(disposingStatuses).toContain("activating");
      await disposing;
      expect(platform.status).toBe("disposed");
      expect(platform.registrations()).toEqual([]);
      expect(getEventListeners(signal, "abort")).toEqual([]);
    } finally {
      subscription[Symbol.dispose]();
      loading.resolve(module);
      await outcome;
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it.each(["timeout", "composite"] as const)(
  "finishes an activation rejected by %s cancellation attachment without stranding disposal",
  async (kind) => {
    const host = createHost({ resourceAuthority });
    const load = vi.fn<() => unknown>(() => ({ default: emptyPlugin("sample") }));
    const platform = createPlatform({
      id: "rejected-operation-admission",
      host,
      apiVersion: "1.0.0",
      loader: { load },
    });
    const registration = await select(platform, "sample", "one");
    const signal = cancellationSignal(kind);
    const failure = new Error("caller observation failed during activation admission");
    let rejectAttachment = false;
    Object.defineProperty(signal, "aborted", {
      get() {
        if (rejectAttachment) throw failure;
        return Reflect.get(AbortSignal.prototype, "aborted", signal);
      },
    });
    try {
      const activation = platform.activate([registration], { signal });
      rejectAttachment = true;
      await expect(activation).rejects.toBe(failure);
      expect(load).not.toHaveBeenCalled();
      expect(registration.status).toBe("selected");
      expect(getEventListeners(signal, "abort")).toEqual([]);
      await expect(
        Promise.race([
          platform[Symbol.asyncDispose]().then(() => "disposed"),
          nextTurn().then(() => "pending"),
        ]),
      ).resolves.toBe("disposed");
    } finally {
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);
