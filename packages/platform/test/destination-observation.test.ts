import { createHost, createResourceAuthority, definePlugin, type Disposable } from "dougong";
import { describe, expect, it } from "vitest";
import { createPlatform } from "../src";
import { nextTurn, select, withDiagnosticsSubscription } from "./fixtures";

const resourceAuthority = createResourceAuthority();

describe.each(["load", "activate"] as const)("%s destination observation", (phase) => {
  it.each([
    "registration failure",
    "missing disposer",
    "unreadable disposer",
    "asynchronous handle",
    "withdrawal failure",
  ] as const)(
    "revokes its binding after %s without retaining Platform capabilities",
    async (mode) => {
      const reports: unknown[] = [];
      const host = createHost({
        resourceAuthority,
        onError(error) {
          reports.push(error);
        },
      });
      const failure = new Error(`${phase} ${mode}`);
      const subscriptions: Disposable[] = [];
      let interceptObservation = false;
      let loads = 0;
      let activationApprovals = 0;
      let setups = 0;
      const source = withDiagnosticsSubscription(host, (listener) => {
        const subscription = host.diagnostics.subscribe(listener);
        subscriptions.push(subscription);
        if (!interceptObservation) return subscription;
        interceptObservation = false;
        if (mode === "registration failure") throw failure;
        if (mode === "missing disposer") return {} as never;
        if (mode === "asynchronous handle") return Promise.resolve(subscription) as never;
        if (mode === "unreadable disposer") {
          return {
            get [Symbol.dispose](): () => void {
              throw failure;
            },
          };
        }
        return {
          [Symbol.dispose]() {
            throw failure;
          },
        };
      });
      async function rejectActivation() {
        const loader = {
          load() {
            loads++;
            if (phase === "activate") interceptObservation = true;
            return {
              default: definePlugin({
                name: "sample",
                setup() {
                  setups++;
                },
              }),
            };
          },
        };
        const authorizer = {
          authorize({ operation }: { readonly operation: "load" | "activate" }) {
            if (operation === "activate") activationApprovals++;
          },
        };
        const logger = { debug() {}, info() {}, warn() {}, error() {} };
        const platform = createPlatform({
          id: "destination-observation",
          host: source,
          apiVersion: "1.0.0",
          loader,
          authorizer,
          logger,
        });
        const registration = await select(platform, "sample", "one");
        if (phase === "load") interceptObservation = true;
        const rejection: unknown = await platform
          .activate([registration])
          .catch((error: unknown) => error);
        const invalidHandle = mode === "missing disposer" || mode === "asynchronous handle";
        expect(rejection).toEqual(
          invalidHandle
            ? new TypeError("Host diagnostics subscribe() must return a Disposable")
            : failure,
        );
        expect(rejection === failure).toBe(!invalidHandle);
        expect(loads).toBe(phase === "activate" || mode === "withdrawal failure" ? 1 : 0);
        expect(activationApprovals).toBe(
          phase === "activate" && mode === "withdrawal failure" ? 1 : 0,
        );
        expect(setups).toBe(0);
        expect(host.installation(registration.id)).toBeUndefined();
        await platform[Symbol.asyncDispose]();
        return {
          view: platform.diagnostics,
          references: [
            new WeakRef(platform),
            new WeakRef(loader),
            new WeakRef(authorizer),
            new WeakRef(logger),
          ],
        };
      }
      try {
        const { view, references } = await rejectActivation();
        for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
          await nextTurn();
          globalThis.gc!();
        }
        expect(references.map((reference) => reference.deref())).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
        expect(view.get().status).toBe("disposed");
        await host.start();
        expect(reports).toEqual([]);
      } finally {
        for (const subscription of subscriptions) subscription[Symbol.dispose]();
        await host.stop();
      }
    },
  );
});
