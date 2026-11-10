import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const workspace = mkdtempSync(join(tmpdir(), "dougong-resource-authority-"));
let firstCore;
let secondCore;

beforeAll(async () => {
  const entry = fileURLToPath(new URL("../../packages/dougong/src/index.ts", import.meta.url));
  const bundles = await Promise.all(
    ["first", "second"].map(async (name) => {
      const output = join(workspace, name);
      await build({
        configFile: false,
        logLevel: "silent",
        build: {
          target: "esnext",
          minify: false,
          outDir: output,
          lib: { entry, formats: ["es"], fileName: () => "core.mjs" },
        },
      });
      return import(/* @vite-ignore */ pathToFileURL(join(output, "core.mjs")).href);
    }),
  );
  [firstCore, secondCore] = bundles;
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function fixture(core, resourceAuthority, setup = () => undefined) {
  let context;
  const host = core.createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: core.definePlugin({
          name: "owner",
          setup(current) {
            context = current;
            setup(current);
          },
        }),
      },
    ],
  });
  return { host, context: () => context };
}

it("gives one external resource one owner across independently bundled Core copies", async () => {
  expect(firstCore.createHost).not.toBe(secondCore.createHost);
  expect(firstCore.createResourceAuthority).not.toBe(secondCore.createResourceAuthority);
  const resourceAuthority = firstCore.createResourceAuthority();
  const first = fixture(firstCore, resourceAuthority);
  const second = fixture(secondCore, resourceAuthority);
  const release = vi.fn();
  const resource = { [Symbol.dispose]: release };
  await Promise.all([first.host.start(), second.host.start()]);
  try {
    first.context().lifetime.use(resource);
    expect(() => second.context().lifetime.use(resource)).toThrow(
      "Resource already has a Lifetime owner",
    );
    await expect(second.context().lifetime.acquire(() => resource)).rejects.toThrow(
      "Resource already has a Lifetime owner",
    );
    await second.host.stop();
    expect(release).not.toHaveBeenCalled();
  } finally {
    await Promise.all([first.host.stop(), second.host.stop()]);
  }
  expect(release).toHaveBeenCalledOnce();
});

it("retains a shared reservation until the original copy actually finishes cleanup", async () => {
  const resourceAuthority = secondCore.createResourceAuthority();
  const first = fixture(firstCore, resourceAuthority);
  const second = fixture(secondCore, resourceAuthority);
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const release = vi.fn(() => {
    entered.resolve();
    return gate.promise;
  });
  const resource = { [Symbol.asyncDispose]: release };
  await Promise.all([first.host.start(), second.host.start()]);
  first.context().lifetime.use(resource);
  const closing = first.host.stop();
  try {
    await entered.promise;
    expect(() => second.context().lifetime.use(resource)).toThrow(
      "Resource already has a Lifetime owner",
    );
    gate.resolve();
    await closing;
    second.context().lifetime.use(resource);
    await second.host.stop();
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    gate.resolve();
    await closing;
    await second.host.stop();
  }
});

it("preserves every control handle's provenance across copies and after completion", async () => {
  const resourceAuthority = firstCore.createResourceAuthority();
  const handles = [];
  const release = vi.fn();
  const point = firstCore.extensionPoint("resource-domain/items");
  const notice = firstCore.event("resource-domain/notice");
  let child;
  const first = firstCore.createHost({
    resourceAuthority,
    installations: [
      {
        id: "owner",
        plugin: firstCore.definePlugin({
          name: "owner",
          requires: { items: point },
          setup({ lifetime, dependencies, events, contributions }) {
            child = lifetime.child("child");
            handles.push(
              lifetime,
              child,
              lifetime.defer(release),
              lifetime.interrupt(() => undefined),
              lifetime.spawn(() => undefined),
              events.on(notice, () => undefined),
              contributions.add(point, "entry", 1),
              dependencies.items.subscribe(() => undefined),
            );
          },
        }),
      },
    ],
  });
  const second = fixture(secondCore, resourceAuthority);
  await Promise.all([first.start(), second.host.start()]);
  const rejectAdoption = async () => {
    for (const handle of handles) {
      expect(() => second.context().lifetime.use(handle)).toThrow(
        "Owned control handles cannot be adopted as resources",
      );
      await expect(second.context().lifetime.acquire(() => handle)).rejects.toThrow(
        "Owned control handles cannot be adopted as resources",
      );
    }
  };
  try {
    await rejectAdoption();
    expect(child.signal.aborted).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await first.stop();
    expect(release).toHaveBeenCalledOnce();
    await rejectAdoption();
  } finally {
    await Promise.all([first.stop(), second.host.stop()]);
  }
  expect(release).toHaveBeenCalledOnce();
});
