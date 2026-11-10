import { describe, expect, it } from "vitest";
import { createResourceAuthority, createHost } from "dougong";
import { createPlatform, MemoryLoader } from "../src";
import { fixture, select, VALUE, valuePlugin } from "./fixtures";

const resourceAuthority = createResourceAuthority();

describe("Registration installation authority", () => {
  it("never adopts another Platform's installation through a matching id and revision", async () => {
    const host = createHost({ resourceAuthority });
    const first = createPlatform({
      id: "shared-name",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["module", { default: valuePlugin("sample", 1) }]])),
    });
    const second = createPlatform({
      id: "shared-name",
      host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["module", { default: valuePlugin("sample", 2) }]])),
    });
    const owned = await select(first, "sample", "module");
    const foreign = await select(second, "sample", "module");
    await host.start();
    await first.activate([owned]);
    expect(foreign.installation).toBeUndefined();
    expect(foreign.activeOrigin).toBeUndefined();
    expect(second.diagnostics.get().registrations.get("sample")?.execution).toBeUndefined();
    expect(second.preview([foreign]).selections[0]?.action).toBe("install");
    await expect(second.activate([foreign])).rejects.toMatchObject({
      code: "INSTALLATION_CONFLICT",
    });
    expect(foreign.installation).toBeUndefined();
    await second[Symbol.asyncDispose]();
    expect(host.installation(owned.id)).toBe(owned.installation);
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(1);
    await first[Symbol.asyncDispose]();
    await host.stop();
  });

  it("lets Core arbitrate concurrent attempts at the same installation identity", async () => {
    const host = createHost({ resourceAuthority });
    const platforms = [1, 2].map((value) =>
      createPlatform({
        id: "race",
        host,
        apiVersion: "1.0.0",
        loader: new MemoryLoader(new Map([["module", { default: valuePlugin("sample", value) }]])),
      }),
    );
    const registrations = await Promise.all(
      platforms.map((platform) => select(platform, "sample", "module")),
    );
    await host.start();
    const results = await Promise.allSettled(
      platforms.map((platform, index) => platform.activate([registrations[index]!])),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const loser = 1 - winner;
    expect(registrations[winner]!.installation).toBeDefined();
    expect(registrations[loser]!.installation).toBeUndefined();
    expect(registrations[loser]!.activeOrigin).toBeUndefined();
    await platforms[loser]![Symbol.asyncDispose]();
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(winner + 1);
    await platforms[winner]![Symbol.asyncDispose]();
    await host.stop();
  });

  it("does not reuse, update or remove a new Core identity that inherited the same id and origin data", async () => {
    const { host, platform } = fixture(
      resourceAuthority,
      new Map([["module", valuePlugin("sample", 1)]]),
    );
    const registration = await select(platform, "sample", "module");
    await host.start();
    await platform.activate([registration]);
    const previous = registration.installation!;
    const origin = previous.origin!;
    const change = host.change();
    change.remove(previous);
    await host.apply(await host.plan(change));
    const replacementChange = host.change();
    const replacement = replacementChange.install(valuePlugin("sample", 9), {
      id: registration.id,
      origin,
    });
    await host.apply(await host.plan(replacementChange));
    expect(previous.status).toBe("removed");
    expect(registration.installation).toBeUndefined();
    expect(registration.activeOrigin).toBeUndefined();
    expect(platform.diagnostics.get().registrations.get("sample")).toMatchObject({
      status: "selected",
      activeOrigin: undefined,
      execution: undefined,
    });
    await expect(platform.activate([registration])).rejects.toMatchObject({
      code: "INSTALLATION_CONFLICT",
    });
    await platform.remove(registration);
    expect(host.installation(registration.id)).toBe(replacement);
    expect((await host.use(VALUE, (value) => value.value)).value).toBe(9);
    await platform[Symbol.asyncDispose]();
    await host.stop();
  });
});
