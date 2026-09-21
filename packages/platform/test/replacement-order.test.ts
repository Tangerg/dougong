import { expect, it } from "vitest";
import { createHost, definePlugin, service } from "@dougongjs/core";
import { createPlatform, MemoryLoader } from "../src/index";

it.each([false, true])(
  "validates same-name replacement by final state (register first: %s)",
  async (registerFirst) => {
    const host = createHost();
    const value = service<string>("replacement/value");
    const plugin = (result: string) =>
      definePlugin({
        name: "replacement",
        provides: { value },
        setup() {
          return { value: result };
        },
      });
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["new", { default: plugin("loaded") }]])),
    });
    const old = await platform.register({
      manifest: { name: "replacement", version: "1.0.0" },
      reference: "old",
      placeholder: plugin("old"),
    });
    await host.start();
    const changes = platform.change();
    if (!registerFirst) changes.remove(old);
    const replacement = changes.register({
      manifest: { name: "replacement", version: "2.0.0" },
      reference: "new",
      placeholder: plugin("new"),
    });
    if (registerFirst) changes.remove(old);
    await changes.commit();
    expect(old.status).toBe("removed");
    expect(replacement.status).toBe("registered");
    expect(host.get(value)).toBe("new");
    await replacement.activate();
    expect(host.get(value)).toBe("loaded");
    await platform.dispose();
    await host.stop();
  },
);

it.each([false, true])(
  "restores the old Registration when same-name replacement fails (register first: %s)",
  async (registerFirst) => {
    const host = createHost();
    const value = service<string>("replacement/value");
    const oldPlugin = definePlugin({
      name: "replacement",
      provides: { value },
      setup() {
        return { value: "old" };
      },
    });
    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map([["old", { default: oldPlugin }]])),
    });
    const old = await platform.register({
      manifest: { name: "replacement", version: "1.0.0" },
      reference: "old",
    });
    await old.activate();
    await host.start();
    const changes = platform.change();
    if (!registerFirst) changes.remove(old);
    const replacement = changes.register({
      manifest: { name: "replacement", version: "2.0.0" },
      reference: "new",
      placeholder: definePlugin({
        name: "replacement",
        setup() {
          throw new Error("replacement rejected");
        },
      }),
    });
    if (registerFirst) changes.remove(old);
    await expect(changes.commit()).rejects.toThrow("replacement rejected");
    expect(old.status).toBe("installed");
    await expect(old.ready()).resolves.toBeUndefined();
    expect(replacement.status).toBe("failed");
    await expect(replacement.ready()).rejects.toThrow("replacement rejected");
    expect(host.get(value)).toBe("old");
    await old.remove();
    expect(old.status).toBe("removed");
    await platform.dispose();
    await host.stop();
  },
);
