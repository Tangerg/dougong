import { expect, it } from "vitest";
import { createResourceAuthority, createHost, definePlugin, type Disposable } from "dougong";
import { createPlatform } from "../src";
import { nextTurn, select, withDiagnosticsSubscription } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it.each([
  "registration failure",
  "missing disposer",
  "unreadable disposer",
  "asynchronous handle",
] as const)(
  "revokes a rejected Platform observation after %s even if its source retains the listener",
  async (mode) => {
    const host = createHost({ resourceAuthority });
    const failure = new Error(mode);
    let subscription: Disposable | undefined;
    const observed = withDiagnosticsSubscription(host, (listener) => {
      subscription = host.diagnostics.subscribe(listener);
      if (mode === "registration failure") throw failure;
      if (mode === "missing disposer") return {} as never;
      if (mode === "asynchronous handle") return Promise.reject(failure) as never;
      return {
        get [Symbol.dispose](): () => void {
          throw failure;
        },
      };
    });
    function rejectConstruction() {
      const loader = { load: () => ({ default: definePlugin({ name: "sample", setup() {} }) }) };
      const authorizer = { authorize() {} };
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      expect(() =>
        createPlatform({
          id: "rejected-observation",
          host: observed,
          apiVersion: "1.0.0",
          loader,
          authorizer,
          logger,
        }),
      ).toThrow(
        mode === "missing disposer" || mode === "asynchronous handle"
          ? "Host diagnostics subscribe() must return a Disposable"
          : failure,
      );
      return [new WeakRef(loader), new WeakRef(authorizer), new WeakRef(logger)];
    }
    try {
      const references = rejectConstruction();
      for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
        await nextTurn();
        globalThis.gc!();
      }
      expect(references.map((reference) => reference.deref())).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      await host.start();
    } finally {
      subscription?.[Symbol.dispose]();
      await host.stop();
    }
  },
);

it("detaches terminal capabilities after failed withdrawal while the Host retains its listener", async () => {
  const host = createHost({ resourceAuthority });
  const failure = new Error("withdrawal failed before releasing its source subscription");
  let subscription: Disposable | undefined;
  const observed = withDiagnosticsSubscription(host, (listener) => {
    subscription = host.diagnostics.subscribe(listener);
    return {
      [Symbol.dispose]() {
        throw failure;
      },
    };
  });
  async function rejectDisposal() {
    const loader = { load: () => ({ default: definePlugin({ name: "sample", setup() {} }) }) };
    const authorizer = { authorize() {} };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const platform = createPlatform({
      id: "failed-withdrawal",
      host: observed,
      apiVersion: "1.0.0",
      loader,
      authorizer,
      logger,
    });
    await expect(platform[Symbol.asyncDispose]()).rejects.toBe(failure);
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
    const { view, references } = await rejectDisposal();
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
  } finally {
    subscription?.[Symbol.dispose]();
    await host.stop();
  }
});

it("detaches terminal handles, diagnostic views and historical failures from live capabilities", async () => {
  const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
  const fixture = await createDetachedViews();
  const references = Object.values(fixture.references);
  for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
    await nextTurn();
    collectGarbage();
    collectGarbage();
  }
  expect(fixture.registration.status).toBe("removed");
  expect(fixture.snapshot?.status).toBe("failed");
  expect(fixture.diagnostics.get().status).toBe("disposed");
  fixture.subscription[Symbol.dispose]();
  expect(
    Object.fromEntries(
      Object.entries(fixture.references).map(([name, reference]) => [
        name,
        reference.deref() === undefined,
      ]),
    ),
  ).toEqual({ host: true, loader: true, platform: true });
});

async function createDetachedViews() {
  const host = createHost({ resourceAuthority });
  const loader = {
    load() {
      throw new Error("historical failure", { cause: host });
    },
  };
  const platform = createPlatform({ id: "retention", host, apiVersion: "1.0.0", loader });
  const registration = await select(platform, "sample", "unused");
  await platform.activate([registration]).catch(() => undefined);
  const diagnostics = platform.diagnostics;
  const snapshot = diagnostics.get().registrations.get("sample");
  const subscription = diagnostics.subscribe(() => {
    void host;
    void loader;
    void platform;
  });
  const references = {
    host: new WeakRef(host),
    loader: new WeakRef(loader),
    platform: new WeakRef(platform),
  };
  await platform[Symbol.asyncDispose]();
  return { registration, diagnostics, subscription, snapshot, references };
}

const preparationPhases = ["load", "module", "validation", "activate"] as const;

it.each(preparationPhases)(
  "terminal Platform releases its artifact and ports despite abandoned %s that never settles",
  async (phase) => {
    const pending = Promise.withResolvers<never>();
    const references = await abandonPreparation(phase, pending.promise);
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
    for (
      let pass = 0;
      pass < 8 && Object.values(references).some((reference) => reference.deref());
      pass++
    ) {
      await nextTurn();
      collectGarbage();
    }
    expect(
      Object.fromEntries(
        Object.entries(references).map(([name, reference]) => [
          name,
          reference.deref() === undefined,
        ]),
      ),
    ).toEqual({
      logger: true,
      reference: true,
      loader: true,
      host: true,
      platform: true,
    });
    pending.reject(new Error("late"));
  },
);

async function abandonPreparation(
  phase: (typeof preparationPhases)[number],
  pending: Promise<never>,
) {
  const entered = Promise.withResolvers<void>();
  const stall = () => {
    entered.resolve();
    return pending;
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = createHost({ resourceAuthority, logger });
  const loader = {
    load(_reference: object, signal: AbortSignal) {
      signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      if (phase === "module") return stall();
      return {
        default: definePlugin({
          name: "example",
          configuration: {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: (input) => (phase === "validation" ? stall() : { value: input }),
            },
          },
          setup() {},
        }),
      };
    },
  };
  const reference = {};
  const platform = createPlatform({
    id: "retention",
    apiVersion: "1.0.0",
    host,
    loader,
    authorizer: {
      authorize({ operation }, signal) {
        signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
        return phase === operation ? stall() : undefined;
      },
    },
  });
  const [chosen] = await platform.select([
    platform.catalog.add({
      revision: "v1",
      manifest: { name: "example", version: "1.0.0" },
      reference,
    }),
  ]);
  const activation = platform.activate([chosen]).catch((error: unknown) => error);
  await entered.promise;
  await platform[Symbol.asyncDispose]();
  expect(await activation).toMatchObject({ name: "AbortError" });
  expect(host.installation(chosen.id)).toBeUndefined();
  return {
    logger: new WeakRef(logger),
    reference: new WeakRef(reference),
    loader: new WeakRef(loader),
    host: new WeakRef(host),
    platform: new WeakRef(platform),
  };
}

it("releases admission, loader and logger capabilities while application code retains the disposed Platform", async () => {
  async function dispose() {
    const loader = { load: () => ({ default: definePlugin({ name: "sample", setup() {} }) }) };
    const authorizer = { authorize() {} };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const host = createHost({ resourceAuthority });
    const platform = createPlatform({
      id: "retained",
      host,
      apiVersion: "1.0.0",
      loader,
      authorizer,
      logger,
    });
    await platform.activate([await select(platform, "sample", "one")]);
    await platform[Symbol.asyncDispose]();
    return {
      platform,
      references: [
        new WeakRef(host),
        new WeakRef(loader),
        new WeakRef(authorizer),
        new WeakRef(logger),
      ],
    };
  }
  const { platform, references } = await dispose();
  const collectGarbage = globalThis.gc;
  if (!collectGarbage) throw new TypeError("Retention tests require Node.js --expose-gc");
  for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
    await nextTurn();
    collectGarbage();
  }
  expect(platform.status).toBe("disposed");
  expect(references.map((reference) => reference.deref())).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});
