import {
  createApp,
  createPlatform,
  definePlugin,
  extension,
  MemoryPluginLoader,
  PermissionSet,
  service,
  type ExtensionView,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Filesystem {
  read(path: string): Promise<string>;
}

interface WorkspaceState {
  readonly id: string;
  readonly root: string;
}

interface Command {
  readonly id: string;
  readonly title: string;
  readonly run?: () => Promise<string>;
}

interface Panel {
  readonly id: string;
  readonly title: string;
}

interface CommandCatalog {
  get(id: string): Command | undefined;
  list(): ReadonlyArray<Command>;
}

const FILESYSTEM = service<Filesystem>("examples/lynx/filesystem");
const COMMAND_CATALOG = service<CommandCatalog>("examples/lynx/command-catalog");
const COMMANDS = extension<Command>("examples/lynx/commands");
const PANELS = extension<Panel>("examples/lynx/panels");
const workspaceState = (workspace: string) =>
  service<WorkspaceState>(`examples/lynx/workspaces/${encodeURIComponent(workspace)}/state`);
const MAIN_WORKSPACE = workspaceState("main");

function selectCommand(commands: ExtensionView<Command>, id: string) {
  const matches = [...commands.get().values()].filter((command) => command.id === id);
  if (matches.length > 1) throw new TypeError(`Duplicate command '${id}'`);
  return matches[0];
}

function explorerPlugin(title: string, relativePath: string) {
  return definePlugin({
    name: "examples.lynx.explorer",
    requires: { filesystem: FILESYSTEM, workspace: MAIN_WORKSPACE },
    setup(ctx) {
      ctx.contribute(COMMANDS, "open", {
        id: "explorer.open",
        title: "Open Explorer",
        run: () => ctx.filesystem.read(`${ctx.workspace.root}/${relativePath}`),
      });
      ctx.contribute(PANELS, "explorer", { id: "explorer", title });
    },
  });
}

/**
 * A workbench. Two rules that hosts usually get wrong are made explicit here:
 * command uniqueness is a domain policy, not a Core Extension mode; and a
 * Group owns installations, so it is not a capability scope.
 */
export async function lynxScenario(): Promise<ExampleResult> {
  let rootCatalog!: CommandCatalog;
  let workspacePanels!: ExtensionView<Panel>;
  let workspaceRoot = "";
  let initialWorkspaceCommands = 0;
  const filesystemAdapter = definePlugin({
    name: "examples.lynx.host.filesystem",
    provides: { filesystem: FILESYSTEM },
    setup: () => ({
      filesystem: {
        read: async (path: string) => `contents:${path}`,
      },
    }),
  });
  const catalogPlugin = definePlugin({
    name: "examples.lynx.command-catalog",
    requires: { commands: COMMANDS },
    provides: { catalog: COMMAND_CATALOG },
    setup(ctx) {
      return {
        catalog: {
          get: (id: string) => selectCommand(ctx.commands, id),
          list: () => Object.freeze([...ctx.commands.get().values()]),
        },
      };
    },
  });
  const rootShell = definePlugin({
    name: "examples.lynx.root-shell",
    requires: { catalog: COMMAND_CATALOG },
    setup(ctx) {
      rootCatalog = ctx.catalog;
    },
  });
  const workspaceStatePlugin = definePlugin({
    name: "examples.lynx.workspace-state",
    provides: { workspace: MAIN_WORKSPACE },
    setup: () => ({ workspace: { id: "main", root: "/workspace" } }),
  });
  const workspaceShell = definePlugin({
    name: "examples.lynx.workspace-shell",
    requires: { catalog: COMMAND_CATALOG, panels: PANELS, workspace: MAIN_WORKSPACE },
    setup(ctx) {
      workspacePanels = ctx.panels;
      workspaceRoot = ctx.workspace.root;
      initialWorkspaceCommands = ctx.catalog.list().length;
    },
  });
  const placeholder = definePlugin({
    name: "examples.lynx.explorer",
    setup(ctx) {
      ctx.contribute(COMMANDS, "open", {
        id: "explorer.open",
        title: "Open Explorer",
      });
    },
  });
  const explorerV1 = explorerPlugin("Explorer", "README.md");
  const explorerV2 = explorerPlugin("Files", "GUIDE.md");

  const app = createApp({ name: "lynx-example" });
  app.install(filesystemAdapter);
  app.install(catalogPlugin);
  app.install(rootShell);
  const workspace = app.group("workspace-main", (group) => {
    group.install(workspaceStatePlugin);
    group.install(workspaceShell);
  });
  await app.start();

  const platform = createPlatform({
    container: workspace,
    apiVersion: "1.0.0",
    permissions: new PermissionSet(["filesystem:read"]),
    loader: new MemoryPluginLoader(
      new Map([
        ["explorer-v1", { default: explorerV1 }],
        ["explorer-v2", { default: explorerV2 }],
      ]),
    ),
  });
  const explorer = await platform.register({
    manifest: {
      name: "examples.lynx.explorer",
      version: "1.0.0",
      activation: ["command:explorer.open"],
      permissions: ["filesystem:read"],
    },
    reference: "explorer-v1",
    placeholder,
  });

  const placeholderExecutable = rootCatalog.get("explorer.open")?.run !== undefined;
  await platform.trigger("command:explorer.open");
  const firstOutput = await rootCatalog.get("explorer.open")?.run?.();

  await explorer.update({
    manifest: {
      name: "examples.lynx.explorer",
      version: "1.1.0",
      activation: ["command:explorer.open"],
      permissions: ["filesystem:read"],
    },
    reference: "explorer-v2",
  });
  const secondOutput = await rootCatalog.get("explorer.open")?.run?.();
  const panelTitle = [...workspacePanels.get().values()][0]?.title;

  await platform.dispose();
  await workspace.remove();
  const remainingCommands = rootCatalog.list().length;
  let workspaceViewDisposed = false;
  try {
    workspacePanels.get();
  } catch {
    workspaceViewDisposed = true;
  }
  await app.stop();

  return exampleResult({
    id: "10",
    stage: "hosts",
    title: "Lynx: a domain catalog, workspace ownership and updates in place",
    introduces: ["domain-catalog", "workspace-ownership", "plugin-update"],
    facts: [
      "Command uniqueness is a CommandCatalog Service policy, not a special Core Extension mode.",
      `The workspace shell bound to '${workspaceRoot}' with ${initialWorkspaceCommands} initial commands.`,
      `The catalog listed the command before activation, but it was executable = ${placeholderExecutable}.`,
      `An update kept the plugin's identity while replacing its implementation: '${firstOutput}' → '${secondOutput}', panel now '${panelTitle}'.`,
      "A root-level consumer saw the Group's contribution — a Group is ownership, not a capability scope.",
      `Removing the workspace released the whole subtree: ${remainingCommands} commands left, its view disposed = ${workspaceViewDisposed}.`,
    ],
  });
}
