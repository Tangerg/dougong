import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost } from "dougong";
import { createPlatform, ImportLoader } from "../src";
import { add, deferred } from "./fixtures";

const resourceAuthority = createResourceAuthority();

it.each(["selection", "admission"] as const)(
  "keeps captured import revisions stable when a URL changes during %s",
  async (phase) => {
    const name = "sample";
    const initialVersion = "1.0.0";
    const replacementVersion = "2.0.0";
    const reference = new URL(moduleSpecifier(name, initialVersion));
    const replacementSpecifier = moduleSpecifier(name, replacementVersion);
    const { host, platform, info, entered, resume } = importFixture(initialVersion);
    const initial = add(platform, name, reference.href, initialVersion);
    if (phase === "selection") reference.href = replacementSpecifier;
    const [registration] = await platform.select([initial]);
    await host.start();
    const activation = platform.activate([registration]);
    try {
      await entered.promise;
      if (phase === "admission") reference.href = replacementSpecifier;
      resume.resolve();
      await activation;

      expect(initial.reference).toBe(moduleSpecifier(name, initialVersion));
      expect(registration.selectionRevision).toBe(1);
      expect(registration.activeOrigin?.revision).toBe(initialVersion);
      expect(info.mock.calls.map(([message]) => message)).toEqual([initialVersion]);
      const installation = registration.installation;

      const replacement = add(platform, name, reference.href, replacementVersion);
      expect((await platform.select([replacement]))[0]).toBe(registration);
      expect(registration.selectionRevision).toBe(2);
      expect(registration.activeOrigin?.revision).toBe(initialVersion);
      await platform.activate([registration]);

      expect(registration.installation).toBe(installation);
      expect(registration.activeOrigin?.revision).toBe(replacementVersion);
      expect(info.mock.calls.map(([message]) => message)).toEqual([
        initialVersion,
        replacementVersion,
      ]);
    } finally {
      resume.resolve();
      await activation.catch(() => undefined);
      await platform[Symbol.asyncDispose]();
      await host.stop();
    }
  },
);

it("rejects a mutable JavaScript artifact reference after admission without installing its changed target", async () => {
  const name = "sample";
  const initialVersion = "1.0.0";
  const reference = new URL(moduleSpecifier(name, initialVersion));
  const { host, platform, info, entered, resume } = importFixture(initialVersion);
  const [registration] = await platform.select([
    add(platform, name, reference as never, initialVersion),
  ]);
  await host.start();
  const activation = platform.activate([registration]).catch((error: unknown) => error);
  try {
    await entered.promise;
    reference.href = moduleSpecifier(name, "2.0.0");
    resume.resolve();

    expect(await activation).toMatchObject({
      code: "MODULE_LOAD_FAILED",
      cause: expect.any(TypeError),
    });
    expect(registration.installation).toBeUndefined();
    expect(registration.activeOrigin).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    await activation;
    await platform[Symbol.asyncDispose]();
    await host.stop();
  }
});

function moduleSpecifier(name: string, version: string) {
  const source = `export default { name: ${JSON.stringify(name)}, setup({ logger }) { logger.info(${JSON.stringify(version)}); } };`;
  return "data:text/javascript," + encodeURIComponent(source);
}

function importFixture(initialRevision: string) {
  const entered = deferred();
  const resume = deferred();
  const info = vi.fn<(message: unknown) => void>();
  const host = createHost({
    resourceAuthority,
    logger: { debug() {}, info, warn() {}, error() {} },
  });
  const platform = createPlatform({
    id: "imports",
    host,
    apiVersion: "1.0.0",
    loader: new ImportLoader(),
    authorizer: {
      async authorize({ artifact, operation }) {
        if (operation === "load" && artifact.revision === initialRevision) {
          entered.resolve();
          await resume.promise;
        }
      },
    },
  });
  return { host, platform, info, entered, resume };
}
