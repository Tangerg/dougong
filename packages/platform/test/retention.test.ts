import { expect, it } from "vitest";
import { createHost, definePlugin } from "dougong";
import { createPlatform } from "../src";
import { nextTurn, select } from "./fixtures";

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
  const host = createHost();
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

it.each(["admission", "module", "validation"] as const)(
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
  phase: "admission" | "module" | "validation",
  pending: Promise<never>,
) {
  const entered = Promise.withResolvers<void>();
  const stall = () => {
    entered.resolve();
    return pending;
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = createHost({ logger });
  const loader = {
    load(_reference: object, signal: AbortSignal) {
      signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
      if (phase === "validation") {
        return {
          default: definePlugin({
            name: "example",
            configuration: { "~standard": { version: 1, vendor: "test", validate: stall } },
            setup() {},
          }),
        };
      }
      return stall();
    },
  };
  const reference = {};
  const platform = createPlatform({
    id: "retention",
    apiVersion: "1.0.0",
    host,
    loader,
    authorizer: {
      authorize(_request, signal) {
        signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
        return phase === "admission" ? stall() : undefined;
      },
    },
  });
  const chosen = await platform.select(
    platform.catalog.add({
      revision: "v1",
      manifest: { name: "example", version: "1.0.0" },
      reference,
    }),
  );
  const controller = new AbortController();
  const activation = platform
    .activate([chosen], { signal: controller.signal })
    .catch(() => undefined);
  await entered.promise;
  if (phase === "validation") {
    controller.abort();
    await activation;
  }
  await platform[Symbol.asyncDispose]();
  await activation;
  return {
    logger: new WeakRef(logger),
    reference: new WeakRef(reference),
    loader: new WeakRef(loader),
    host: new WeakRef(host),
    platform: new WeakRef(platform),
  };
}

it("releases admission and loader capabilities while application code retains the disposed Platform", async () => {
  async function dispose() {
    const loader = { load: () => ({ default: definePlugin({ name: "sample", setup() {} }) }) };
    const authorizer = { authorize() {} };
    const host = createHost();
    const platform = createPlatform({
      id: "retained",
      host,
      apiVersion: "1.0.0",
      loader,
      authorizer,
    });
    await platform.activate([await select(platform, "sample", "one")]);
    await platform[Symbol.asyncDispose]();
    return {
      platform,
      references: [new WeakRef(host), new WeakRef(loader), new WeakRef(authorizer)],
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
  ]);
});
