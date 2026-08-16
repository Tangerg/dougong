import { describe, expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  DougongError,
  event,
  extensionPoint,
  service,
  type Group,
} from "../src/index";

describe("plugin groups", () => {
  it("groups ownership without creating a second capability namespace", async () => {
    const FILES = service<{ read(): string }>("group/files");
    const ITEMS = extensionPoint<string>("group/items");
    const NOTICE = event<string>("group/notice");
    const notices = vi.fn<(value: string) => void>();
    let items: ReadonlyMap<string, string> = new Map();

    const filesPlugin = definePlugin({
      name: "group.files",
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

    const host = createHost();
    host.install(filesPlugin);
    host.install(shell);
    await host.start();

    const group = host.group("workspace", (workspace) => {
      workspace.install(feature);
    });
    await group.ready();

    expect([...items.values()]).toEqual(["shared"]);
    expect(notices).toHaveBeenCalledExactlyOnceWith("visible");

    await group.remove();
    expect(items.size).toBe(0);
    await host.stop();
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

    const host = createHost();
    const rootInstallation = host.install(owned("root"));
    let session!: Group;
    const workspace = host.group("workspace", (group) => {
      group.install(owned("workspace"));
      session = group.group("session", (current) => {
        current.install(owned("session"));
      });
    });
    await host.start();

    await workspace.remove();
    expect(rootInstallation.status).toBe("active");
    expect(workspace.status).toBe("removed");
    expect(session.status).toBe("removed");
    expect(() => session.change()).toThrow("has been removed");
    expect(host.diagnostics.get().groups.has("/workspace")).toBe(false);
    expect(trace).toEqual([
      "start:root",
      "start:workspace",
      "start:session",
      "stop:session",
      "stop:workspace",
    ]);
    await expect(workspace.remove()).resolves.toBeUndefined();
    await expect(session.remove()).resolves.toBeUndefined();

    await host.stop();
    expect(trace.at(-1)).toBe("stop:root");
  });

  it("revokes ChangeSets created before their Group was removed", async () => {
    const plugin = definePlugin({ name: "group.stale-change", setup() {} });
    const host = createHost();
    const group = host.group("stale", () => {});
    const installation = group.install(plugin);
    await host.start();

    const installing = group.change();
    const draft = installing.install(plugin);
    const updating = group.change();
    updating.update(installation, { plugin });
    await group.remove();

    await expect(installing.commit()).rejects.toMatchObject({ code: "GROUP_REMOVED" });
    await expect(updating.commit()).rejects.toMatchObject({ code: "GROUP_REMOVED" });
    expect(draft.status).toBe("failed");
    await expect(draft.ready()).rejects.toMatchObject({ code: "GROUP_REMOVED" });
    expect(installation.status).toBe("removed");
    await host.stop();
  });

  it("revokes every operation on an open ChangeSet when its Group is removed", async () => {
    const plugin = definePlugin({ name: "group.revoked-draft", setup() {} });
    const host = createHost();
    const group = host.group("revoked-draft", () => {});
    const installation = group.install(plugin);
    await host.start();
    const change = group.change();

    await group.remove();

    expect(() => change.install(plugin)).toThrowError(
      expect.objectContaining({ code: "GROUP_REMOVED" }),
    );
    expect(() => change.update(installation, { plugin })).toThrowError(
      expect.objectContaining({ code: "GROUP_REMOVED" }),
    );
    await expect(change.commit()).rejects.toMatchObject({ code: "GROUP_REMOVED" });
    await host.stop();
  });

  it("serializes an empty ChangeSet behind an earlier Group removal", async () => {
    const host = createHost();
    const group = host.group("empty-after-removal", () => {});
    const stale = group.change();

    const removal = group.remove();
    const committing = stale.commit();

    await expect(committing).rejects.toMatchObject({ code: "GROUP_REMOVED" });
    await removal;
    expect(group.status).toBe("removed");
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

    const host = createHost();
    host.install(root);
    await host.start();
    const group = host.group("broken", (group) => {
      group.install(broken);
    });

    await expect(group.ready()).rejects.toThrow("group failed");
    expect(group.status).toBe("failed");
    expect(host.status).toBe("active");
    expect({ rootStarts, rootStops }).toEqual({ rootStarts: 1, rootStops: 0 });

    await group.remove();
    await host.stop();
    expect(rootStops).toBe(1);
  });

  it("classifies non-Error live failures without publishing a healthy Group state", async () => {
    const failure: unknown = undefined;
    const host = createHost();
    await host.start();
    const group = host.group("non-error", (group) => {
      group.install(
        definePlugin({
          name: "group.non-error",
          setup() {
            throw failure;
          },
        }),
      );
    });

    await expect(group.ready()).rejects.toMatchObject({
      name: "DougongError",
      code: "GROUP_UNAVAILABLE",
      message: "Group '/non-error' operation failed with a non-Error value",
    });
    expect(group.status).toBe("failed");

    await group.remove();
    await host.stop();
  });

  it("preserves explicit Error values at the Group boundary", async () => {
    const failure = new DougongError("INSTALLATION_UNAVAILABLE", "explicit failure", {
      cause: undefined,
    });
    const host = createHost();
    await host.start();
    const group = host.group("explicit-error", (group) => {
      group.install(
        definePlugin({
          name: "group.explicit-error",
          setup() {
            throw failure;
          },
        }),
      );
    });

    await expect(group.ready()).rejects.toBe(failure);
    await group.remove();
    await host.stop();
  });

  it("fails a complete nested configuration after any swallowed child failure", () => {
    const failure: unknown = undefined;
    const host = createHost();
    const plugin = definePlugin({ name: "group.must-not-stage", setup() {} });

    expect(() =>
      host.group("outer", (outer) => {
        try {
          outer.group("inner", () => {
            throw failure;
          });
        } catch {
          // A nested failure poisons the shared configuration transaction.
        }
        outer.install(plugin);
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "DougongError",
        code: "GROUP_UNAVAILABLE",
        message: "Group '/outer' configuration failed with a non-Error value",
      }),
    );
    expect(host.diagnostics.get().groups.has("/outer")).toBe(false);
    expect(host.diagnostics.get().installations.size).toBe(0);
  });

  it("enforces synchronous configuration, identity and ChangeSet authority", async () => {
    const host = createHost();
    const plugin = definePlugin({ name: "group.authority", setup() {} });
    const left = host.group("left", () => {});
    const right = host.group("right", (group) => {
      group.install(plugin);
    });
    await Promise.resolve();
    const installation = host.install(plugin);

    expect(() => left.change().remove(installation)).toThrow("outside Group");
    expect(() => host.group("left", () => {})).toThrow("already exists");
    expect(() => host.group("bad/name", () => {})).toThrow("cannot contain '/'");
    expect(installation.groupId).toBe("/");
    expect(() => host.group("async", (async () => undefined) as unknown as () => void)).toThrow(
      "must be synchronous",
    );
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberately verify that a non-callable field is ordinary data.
    const ordinaryConfigurationResult = Object.fromEntries([["then", true]]);
    const ordinaryResult = host.group(
      "ordinary-result",
      (() => ordinaryConfigurationResult) as unknown as () => void,
    );
    expect(() =>
      host.group("self-removing", (group) => {
        void group.remove();
      }),
    ).toThrow("while it is being configured");

    await ordinaryResult.remove();
    await right.remove();
  });

  it("replaces a failed creation barrier after a successful recovery", async () => {
    const host = createHost();
    await host.start();
    const group = host.group("recover", (group) => {
      group.install(
        definePlugin({
          name: "group.initial-failure",
          setup() {
            throw new Error("initial group failure");
          },
        }),
      );
    });

    await expect(group.ready()).rejects.toThrow("initial group failure");
    expect(group.status).toBe("failed");

    const recoveredInstallation = group.install(
      definePlugin({ name: "group.recovered", setup() {} }),
    );
    await recoveredInstallation.ready();

    expect(group.status).toBe("active");
    await expect(group.ready()).resolves.toBeUndefined();
    await group.remove();
    await host.stop();
  });

  it("keeps an established Group healthy after a failed mutation rolls back", async () => {
    const host = createHost();
    await host.start();
    const group = host.group("stable", (group) => {
      group.install(definePlugin({ name: "group.stable", setup() {} }));
    });
    await group.ready();

    const change = group.change();
    change.install(
      definePlugin({
        name: "group.failed-change",
        setup() {
          throw new Error("change failed");
        },
      }),
    );
    await expect(change.commit()).rejects.toThrow("change failed");

    expect(group.status).toBe("active");
    await expect(group.ready()).resolves.toBeUndefined();
    await group.remove();
    await host.stop();
  });

  it("preserves established readiness across overlapping queued changes", async () => {
    let releaseSetup!: () => void;
    let markSetupStarted!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      markSetupStarted = resolve;
    });
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const slow = definePlugin({
      name: "group.queued-slow",
      async setup() {
        markSetupStarted();
        await setupGate;
      },
    });
    const broken = definePlugin({
      name: "group.queued-failure",
      setup() {
        throw new Error("queued change failed");
      },
    });

    const host = createHost();
    await host.start();
    const group = host.group("queued", () => {});
    await group.ready();

    const first = group.change();
    first.install(slow);
    const firstCommit = first.commit();
    await setupStarted;

    const second = group.change();
    second.install(broken);
    const secondCommit = second.commit();
    releaseSetup();

    await firstCommit;
    await expect(secondCommit).rejects.toThrow("queued change failed");
    expect(group.status).toBe("active");
    await expect(group.ready()).resolves.toBeUndefined();

    await group.remove();
    await host.stop();
  });
});
