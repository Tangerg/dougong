import { describe, expect, it } from "vitest";
import {
  createHost,
  definePlugin,
  extensionPoint,
  service,
  type ContributionView,
} from "@dougongjs/core";
import { createPlatform, MemoryLoader, PermissionSet } from "../src/index";

describe("host composition scenarios", () => {
  it("supports Planet-style lazy media providers without restarting the player", async () => {
    interface AudioOutput {
      play(uri: string): Promise<void>;
    }
    interface MediaSource {
      resolve(query: string): Promise<string>;
    }
    interface Player {
      play(query: string): Promise<void>;
    }

    const AUDIO = service<AudioOutput>("planet/audio-output");
    const SOURCES = extensionPoint<MediaSource>("planet/media-sources");
    const PLAYER = service<Player>("planet/player");
    const output: string[] = [];
    let playerStarts = 0;
    let player!: Player;

    // Host adapters are ordinary provider plugins, so they participate in the
    // same graph, rollback and ownership rules as every external plugin.
    const audioAdapter = definePlugin({
      name: "planet.host.audio",
      provides: { audio: AUDIO },
      setup: () => ({
        audio: {
          async play(uri: string) {
            output.push(uri);
          },
        },
      }),
    });
    const playerPlugin = definePlugin({
      name: "planet.player",
      requires: { audio: AUDIO, sources: SOURCES },
      provides: { player: PLAYER },
      setup(ctx) {
        playerStarts++;
        return {
          player: {
            async play(query: string) {
              const source = ctx.sources.get().values().next().value as MediaSource | undefined;
              if (!source) throw new Error("No media source");
              await ctx.audio.play(await source.resolve(query));
            },
          },
        };
      },
    });
    const shell = definePlugin({
      name: "planet.shell",
      requires: { player: PLAYER },
      setup: (ctx) => {
        player = ctx.player;
      },
    });
    const remoteProvider = definePlugin({
      name: "planet.provider.remote",
      setup(ctx) {
        ctx.contribute(SOURCES, "remote", {
          resolve: async (query) => `https://media.example/${query}`,
        });
      },
    });

    const host = createHost({ name: "planet" });
    host.install(audioAdapter);
    host.install(playerPlugin);
    host.install(shell);
    await host.start();

    const platform = createPlatform({
      installer: host,
      apiVersion: "1.0.0",
      authorizer: new PermissionSet(["network"]),
      loader: new MemoryLoader(new Map([["remote-provider", { default: remoteProvider }]])),
    });
    const provider = await platform.register({
      manifest: {
        name: "planet.provider.remote",
        version: "1.0.0",
        activation: ["media:remote"],
        permissions: ["network"],
      },
      reference: "remote-provider",
    });

    await expect(player.play("before")).rejects.toThrow("No media source");
    await platform.trigger("media:remote");
    await player.play("track-42");

    expect(output).toEqual(["https://media.example/track-42"]);
    expect(playerStarts).toBe(1);
    await provider.remove();
    await expect(player.play("after")).rejects.toThrow("No media source");
    expect(playerStarts).toBe(1);
    await platform.dispose();
    await host.stop();
  });

  it("supports Lynx-style grouped commands, panels and host permissions", async () => {
    interface Filesystem {
      read(path: string): Promise<string>;
    }
    interface Command {
      readonly id: string;
      readonly run?: () => Promise<string>;
    }
    interface Panel {
      readonly id: string;
      readonly title: string;
    }

    const FILESYSTEM = service<Filesystem>("lynx/filesystem");
    const COMMANDS = extensionPoint<Command>("lynx/commands");
    const PANELS = extensionPoint<Panel>("lynx/panels");
    let rootCommands!: ContributionView<Command>;
    let workspaceCommands!: ContributionView<Command>;
    let workspacePanels!: ContributionView<Panel>;

    const filesystemAdapter = definePlugin({
      name: "lynx.host.filesystem",
      provides: { filesystem: FILESYSTEM },
      setup: () => ({
        filesystem: { read: async (path: string) => `contents:${path}` },
      }),
    });
    const rootShell = definePlugin({
      name: "lynx.root-shell",
      requires: { commands: COMMANDS },
      setup: (ctx) => {
        rootCommands = ctx.commands;
      },
    });
    const workspaceShell = definePlugin({
      name: "lynx.workspace-shell",
      requires: { commands: COMMANDS, panels: PANELS },
      setup: (ctx) => {
        workspaceCommands = ctx.commands;
        workspacePanels = ctx.panels;
      },
    });
    const placeholder = definePlugin({
      name: "lynx.explorer",
      setup(ctx) {
        ctx.contribute(COMMANDS, "open", { id: "explorer.open" });
      },
    });
    const explorer = definePlugin({
      name: "lynx.explorer",
      requires: { filesystem: FILESYSTEM },
      setup(ctx) {
        ctx.contribute(COMMANDS, "open", {
          id: "explorer.open",
          run: () => ctx.filesystem.read("/workspace/readme.md"),
        });
        ctx.contribute(PANELS, "explorer", {
          id: "explorer",
          title: "Explorer",
        });
      },
    });

    const host = createHost({ name: "lynx" });
    host.install(filesystemAdapter);
    host.install(rootShell);
    const workspace = host.group("workspace", (group) => {
      group.install(workspaceShell);
    });
    await host.start();

    const platform = createPlatform({
      installer: workspace,
      apiVersion: "1.0.0",
      authorizer: new PermissionSet(["filesystem:read"]),
      loader: new MemoryLoader(new Map([["explorer", { default: explorer }]])),
    });
    await platform.register({
      manifest: {
        name: "lynx.explorer",
        version: "1.0.0",
        activation: ["command:explorer.open"],
        permissions: ["filesystem:read"],
      },
      reference: "explorer",
      placeholder,
    });

    expect([...rootCommands.get().values()]).toEqual([{ id: "explorer.open" }]);
    expect([...workspaceCommands.get().values()]).toEqual([{ id: "explorer.open" }]);
    expect(workspacePanels.get().size).toBe(0);

    await platform.trigger("command:explorer.open");
    const command = [...workspaceCommands.get().values()][0];
    expect(await command?.run?.()).toBe("contents:/workspace/readme.md");
    expect([...workspacePanels.get().values()]).toEqual([{ id: "explorer", title: "Explorer" }]);
    expect([...rootCommands.get().values()]).toEqual([
      expect.objectContaining({ id: "explorer.open", run: expect.any(Function) }),
    ]);

    await workspace.remove();
    expect(rootCommands.get().size).toBe(0);
    expect(() => workspaceCommands.get()).toThrow("Contribution view has been disposed");
    expect(() => workspacePanels.get()).toThrow("Contribution view has been disposed");
    await platform.dispose();
    expect(platform.status).toBe("disposed");
    await host.stop();
  });
});
