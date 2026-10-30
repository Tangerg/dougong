import { expect, it } from "vitest";
import { createHost } from "dougong";
import { createPlatform } from "../src";
import { nextTurn, select } from "./fixtures";

it("detaches terminal handles, diagnostic views and historical failures from live capabilities", async () => {
  const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!forceGc) throw new TypeError("Retention tests require Node.js --expose-gc");
  const fixture = await createDetachedViews();
  const references = Object.values(fixture.references);
  for (let pass = 0; pass < 8 && references.some((reference) => reference.deref()); pass++) {
    await nextTurn();
    forceGc();
    forceGc();
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
