import { describe, expect, it, vi } from "vitest";
import { createApp, definePlugin, event, extension, service, type PluginGroup } from "../src/index";

describe("plugin groups", () => {
  it("groups ownership without creating a second capability namespace", async () => {
    const FILES = service<{ read(): string }>("group/files");
    const ITEMS = extension<string>("group/items");
    const NOTICE = event<string>("group/notice");
    const notices = vi.fn<(value: string) => void>();
    let items: ReadonlyMap<string, string> = new Map();

    const host = definePlugin({
      name: "group.host",
      provides: { files: FILES },
      setup: () => ({ files: { read: () => "shared" } }),
    });
    const shell = definePlugin({
      name: "group.shell",
      requires: { items: ITEMS },
      setup(ctx) {
        const read = () => {
          items = ctx.items.get();
        };
        read();
        ctx.items.subscribe(read);
        ctx.on(NOTICE, notices);
      },
    });
    const feature = definePlugin({
      name: "group.feature",
      requires: { files: FILES },
      async setup(ctx) {
        ctx.contribute(ITEMS, "feature", ctx.files.read());
        await ctx.emit(NOTICE, "visible");
      },
    });

    const app = createApp();
    app.install(host);
    app.install(shell);
    await app.start();

    const group = app.group("workspace", (workspace) => {
      workspace.install(feature);
    });
    await group.ready();

    expect([...items.values()]).toEqual(["shared"]);
    expect(notices).toHaveBeenCalledExactlyOnceWith("visible");

    await group.remove();
    expect(items.size).toBe(0);
    await app.stop();
  });

  it("composes nested groups and removes the subtree in one operation", async () => {
    const trace: string[] = [];
    const owned = (name: string) =>
      definePlugin({
        name: `group.${name}`,
        setup(ctx) {
          trace.push(`start:${name}`);
          ctx.cleanup(() => trace.push(`stop:${name}`));
        },
      });

    const app = createApp();
    const root = app.install(owned("root"));
    let session!: PluginGroup;
    const workspace = app.group("workspace", (group) => {
      group.install(owned("workspace"));
      session = group.group("session", (current) => {
        current.install(owned("session"));
      });
    });
    await app.start();

    await workspace.remove();
    expect(root.status).toBe("active");
    expect(workspace.status).toBe("removed");
    expect(session.status).toBe("removed");
    expect(() => session.change()).toThrow("has been removed");
    expect(app.diagnostics.get().groups.has("/workspace")).toBe(false);
    expect(trace).toEqual([
      "start:root",
      "start:workspace",
      "start:session",
      "stop:session",
      "stop:workspace",
    ]);
    await expect(workspace.remove()).resolves.toBeUndefined();
    await expect(session.remove()).resolves.toBeUndefined();

    await app.stop();
    expect(trace.at(-1)).toBe("stop:root");
  });

  it("rolls back a failed live group without stopping unrelated plugins", async () => {
    let rootStarts = 0;
    let rootStops = 0;
    const root = definePlugin({
      name: "group.stable-root",
      setup(ctx) {
        rootStarts++;
        ctx.cleanup(() => rootStops++);
      },
    });
    const broken = definePlugin({
      name: "group.broken",
      setup() {
        throw new Error("group failed");
      },
    });

    const app = createApp();
    app.install(root);
    await app.start();
    const group = app.group("broken", (plugins) => {
      plugins.install(broken);
    });

    await expect(group.ready()).rejects.toThrow("group failed");
    expect(group.status).toBe("failed");
    expect(app.status).toBe("active");
    expect({ rootStarts, rootStops }).toEqual({ rootStarts: 1, rootStops: 0 });

    await group.remove();
    await app.stop();
    expect(rootStops).toBe(1);
  });

  it("enforces synchronous configuration, identity and ChangeSet authority", async () => {
    const app = createApp();
    const plugin = definePlugin({ name: "group.authority", setup() {} });
    const left = app.group("left", () => {});
    const right = app.group("right", (group) => {
      group.install(plugin);
    });
    await Promise.resolve();
    const handle = app.install(plugin);

    expect(() => left.change().remove(handle)).toThrow("outside ChangeSet group");
    expect(() => app.group("left", () => {})).toThrow("already exists");
    expect(() => app.group("bad/name", () => {})).toThrow("cannot contain '/'");
    expect(handle.group).toBe("/");
    expect(() => app.group("async", (async () => undefined) as unknown as () => void)).toThrow(
      "must be synchronous",
    );
    expect(() =>
      app.group("self-removing", (group) => {
        void group.remove();
      }),
    ).toThrow("while it is being configured");

    await right.remove();
  });
});
