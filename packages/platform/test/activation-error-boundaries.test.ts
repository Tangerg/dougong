import { createHost, createResourceAuthority, type Host } from "dougong";
import { describe, expect, it } from "vitest";
import { createPlatform, type AdmissionRequest } from "../src";
import { emptyPlugin, select, withDiagnosticsSubscription } from "./fixtures";

const resourceAuthority = createResourceAuthority();

async function preparationFixture(
  phase: AdmissionRequest["operation"],
  signal: AbortSignal,
  prepare: () => void,
  withdraw: () => void,
) {
  const host = createHost({ resourceAuthority });
  let interceptObservation = false;
  const source = withDiagnosticsSubscription(host, (listener) => {
    const subscription = host.diagnostics.subscribe(listener);
    if (!interceptObservation) return subscription;
    interceptObservation = false;
    return {
      [Symbol.dispose]() {
        subscription[Symbol.dispose]();
        withdraw();
      },
    };
  });
  const platform = createPlatform({
    id: "activation-errors",
    host: source,
    apiVersion: "1.0.0",
    loader: {
      load() {
        if (phase === "load") prepare();
        else interceptObservation = true;
        return { default: emptyPlugin("sample") };
      },
    },
    authorizer: {
      authorize({ operation }) {
        if (phase === "activate" && operation === "activate") prepare();
      },
    },
  });
  const registration = await select(platform, "sample", "one");
  if (phase === "load") interceptObservation = true;
  const outcome = platform.activate([registration], { signal }).catch((error: unknown) => error);
  return { host, platform, registration, outcome };
}

describe.each(["load", "activate"] as const)("%s preparation failures", (phase) => {
  it.each(["work failure", "cancelled work", "cancel during withdrawal"] as const)(
    "preserves %s together with diagnostic withdrawal failure",
    async (scenario) => {
      const controller = new AbortController();
      const primary = new Error("preparation did not complete");
      const withdrawal = new Error("diagnostic withdrawal failed");
      const laterCancellation = new Error("cancelled while releasing the failed observation");
      let withdrawals = 0;
      const { host, platform, registration, outcome } = await preparationFixture(
        phase,
        controller.signal,
        () => {
          if (scenario === "cancelled work") controller.abort(primary);
          else throw primary;
        },
        () => {
          withdrawals++;
          if (scenario === "cancel during withdrawal") controller.abort(laterCancellation);
          throw withdrawal;
        },
      );
      try {
        const rejection: unknown = await outcome;
        expect(rejection).toBeInstanceOf(AggregateError);
        const errors = (rejection as AggregateError).errors as unknown[];
        expect(errors).toHaveLength(2);
        const first = errors[0];
        expect(
          phase === "load" && scenario !== "cancelled work" ? (first as Error).cause : first,
        ).toBe(primary);
        expect(errors[1]).toBe(withdrawal);
        expect(withdrawals).toBe(1);
        expect(registration.status).toBe("failed");
        expect(registration.error?.snapshot.errors?.[1]?.message).toBe(withdrawal.message);
        expect(host.installation(registration.id)).toBeUndefined();
      } finally {
        await platform[Symbol.asyncDispose]();
        await host.stop();
      }
      expect(withdrawals).toBe(1);
    },
  );

  it("preserves an independent failure when successful withdrawal cancels the caller", async () => {
    const controller = new AbortController();
    const primary = new Error("preparation failed before cancellation");
    const cancellation = new Error("cancelled while withdrawing observation");
    const { host, platform, registration, outcome } = await preparationFixture(
      phase,
      controller.signal,
      () => {
        throw primary;
      },
      () => controller.abort(cancellation),
    );
    try {
      const rejection: unknown = await outcome;
      expect(controller.signal.aborted).toBe(true);
      expect(phase === "load" ? (rejection as Error).cause : rejection).toBe(primary);
      expect(rejection).not.toBe(cancellation);
      expect(registration.status).toBe("failed");
      expect(host.installation(registration.id)).toBeUndefined();
    } finally {
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  });
});

it.each([false, true])(
  "preserves Core preflight cancellation after handoff (previous failure: %s)",
  async (previousFailure) => {
    const host = createHost({ resourceAuthority });
    const controller = new AbortController();
    const cancellation = new Error("cancelled before Core admission");
    const primary = new Error("previous module load failed");
    const apply: Host["apply"] = (plan, signal) => {
      controller.abort(cancellation);
      return host.apply(plan, signal);
    };
    const forwardedHost = new Proxy({} as Host, {
      get(_target, property) {
        return property === "apply" ? apply : Reflect.get(host, property, host);
      },
    });
    let rejectLoad = previousFailure;
    const platform = createPlatform({
      id: "preflight-cancellation",
      host: forwardedHost,
      apiVersion: "1.0.0",
      loader: {
        load() {
          if (rejectLoad) {
            rejectLoad = false;
            throw primary;
          }
          return { default: emptyPlugin("sample") };
        },
      },
    });
    const registration = await select(platform, "sample", "one");
    await host.start();
    const revision = host.stateRevision;
    try {
      if (previousFailure) await platform.activate([registration]).catch((error: unknown) => error);
      const previous = registration.error;
      expect(Boolean(previous)).toBe(previousFailure);
      await expect(platform.activate([registration], { signal: controller.signal })).rejects.toBe(
        cancellation,
      );
      expect(registration.error).toBe(previous);
      expect(registration.status).toBe(previousFailure ? "failed" : "selected");
      expect(host.stateRevision).toBe(revision);
      expect(host.installation(registration.id)).toBeUndefined();
    } finally {
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);
