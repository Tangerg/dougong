import {
  createHost,
  createResourceAuthority,
  definePlugin,
  type ApplyResult,
  type Host,
} from "dougong";
import { describe, expect, it, vi } from "vitest";
import { createPlatform } from "../src";
import { deferred, emptyPlugin, nextTurn, select } from "./fixtures";

const resourceAuthority = createResourceAuthority();
const shadows = ["fulfillment", "rejection", "unreadable then"] as const;
type Shadow = (typeof shadows)[number];

function decorateResult<T>(result: Promise<T>, value: T, shadow: Shadow) {
  const failure = new Error("Public methods cannot decide Host command settlement");
  const publicThen = vi.fn<
    () => (resolve: (value: T) => void, reject: (error: unknown) => void) => void
  >(() => {
    if (shadow === "unreadable then") throw failure;
    return (resolve: (value: T) => void, reject: (error: unknown) => void) => {
      if (shadow === "rejection") reject(failure);
      else resolve(value);
    };
  });
  Object.defineProperty(result, "constructor", { value: Object });
  // oxlint-disable-next-line unicorn/no-thenable -- Native command settlement remains authoritative through an SDK adapter.
  Object.defineProperty(result, "then", { get: publicThen });
  return publicThen;
}

function withApply(host: Host, apply: Host["apply"]): Host {
  return new Proxy({} as Host, {
    get(_target, property) {
      return property === "apply" ? apply : Reflect.get(host, property, host);
    },
  });
}

describe.each(["fulfills", "rejects"] as const)("actual Core activation %s", (settlement) => {
  it.each(shadows)("ignores Host.apply public %s", async (shadow) => {
    const host = createHost({ resourceAuthority });
    const entered = deferred();
    const completion = deferred();
    const failure = new Error("Actual Core setup failed");
    const release = vi.fn<() => void>();
    const shadowResult: ApplyResult = {
      stateRevision: host.stateRevision,
      affectedInstallations: [],
    };
    let decorate = true;
    let publicThen: ReturnType<typeof decorateResult> | undefined;
    const source = withApply(host, (plan, signal) => {
      const result = host.apply(plan, signal);
      if (decorate) publicThen = decorateResult(result, shadowResult, shadow);
      return result;
    });
    const platform = createPlatform({
      id: "activation-settlement",
      host: source,
      apiVersion: "1.0.0",
      loader: {
        load: () => ({
          default: definePlugin({
            name: "sample",
            setup({ lifetime }) {
              lifetime.defer(release);
              entered.resolve();
              return completion.promise;
            },
          }),
        }),
      },
    });
    const registration = await select(platform, "sample", "one");
    await host.start();
    let settled = false;
    const outcome = platform.activate([registration]).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered.promise;
      await nextTurn();
      expect(settled).toBe(false);
      expect(registration.status).toBe("activating");
      expect(publicThen).not.toHaveBeenCalled();
      if (settlement === "fulfills") completion.resolve();
      else completion.reject(failure);
      const result = await outcome;
      const observed = "error" in result ? (result.error as Error).cause : result.result;
      expect(observed).toEqual(
        settlement === "fulfills"
          ? {
              stateRevision: host.stateRevision,
              affectedInstallations: [registration.id],
            }
          : failure,
      );
      expect(registration.status).toBe(settlement === "fulfills" ? "installed" : "failed");
      expect(publicThen).not.toHaveBeenCalled();
    } finally {
      decorate = false;
      completion.resolve();
      await outcome;
      await nextTurn();
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
    expect(release).toHaveBeenCalledOnce();
  });
});

describe.each(["remove", "dispose"] as const)("Platform %s", (operation) => {
  it.each(shadows)("joins actual Core release despite Host.apply public %s", async (shadow) => {
    const host = createHost({ resourceAuthority });
    const entered = deferred();
    const completion = deferred();
    let decorate = false;
    let publicThen: ReturnType<typeof decorateResult> | undefined;
    const source = withApply(host, (plan, signal) => {
      const result = host.apply(plan, signal);
      if (decorate)
        publicThen = decorateResult(
          result,
          { stateRevision: host.stateRevision, affectedInstallations: [] },
          shadow,
        );
      return result;
    });
    const platform = createPlatform({
      id: "removal-settlement",
      host: source,
      apiVersion: "1.0.0",
      loader: {
        load: () => ({
          default: definePlugin({
            name: "sample",
            setup({ lifetime }) {
              lifetime.defer(() => {
                entered.resolve();
                return completion.promise;
              });
            },
          }),
        }),
      },
    });
    const registration = await select(platform, "sample", "one");
    await host.start();
    await platform.activate([registration]);
    decorate = true;
    let settled = false;
    const result =
      operation === "remove" ? platform.remove(registration) : platform[Symbol.asyncDispose]();
    const outcome = result.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await entered.promise;
      await nextTurn();
      expect(settled).toBe(false);
      expect(platform.status).toBe(operation === "remove" ? "active" : "disposing");
      expect(registration.status).toBe("removing");
      expect(platform.registrations()).toEqual([registration]);
      expect(publicThen).not.toHaveBeenCalled();
      completion.resolve();
      expect(await outcome).toBeUndefined();
      expect(registration.status).toBe("removed");
      expect(platform.registrations()).toEqual([]);
      expect(host.installation(registration.id)).toBeUndefined();
      expect(publicThen).not.toHaveBeenCalled();
    } finally {
      decorate = false;
      completion.resolve();
      await outcome;
      await nextTurn();
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  });
});

it.each(shadows)("uses the actual Core removal Plan despite public %s", async (shadow) => {
  const host = createHost({ resourceAuthority });
  let decorate = false;
  let publicThen: ReturnType<typeof decorateResult> | undefined;
  let shadowPlan: Awaited<ReturnType<Host["plan"]>>;
  const plan: Host["plan"] = (change, signal) => {
    const result = host.plan(change, signal);
    if (decorate) publicThen = decorateResult(result, shadowPlan, shadow);
    return result;
  };
  const source = new Proxy({} as Host, {
    get(_target, property) {
      return property === "plan" ? plan : Reflect.get(host, property, host);
    },
  });
  const platform = createPlatform({
    id: "removal-plan-settlement",
    host: source,
    apiVersion: "1.0.0",
    loader: { load: () => ({ default: emptyPlugin("sample") }) },
  });
  const registration = await select(platform, "sample", "one");
  await host.start();
  await platform.activate([registration]);
  shadowPlan = await host.plan(host.change());
  decorate = true;
  try {
    await expect(platform[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(host.installation(registration.id)).toBeUndefined();
    expect(platform.status).toBe("disposed");
    expect(registration.status).toBe("removed");
    expect(publicThen).not.toHaveBeenCalled();
  } finally {
    decorate = false;
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});
