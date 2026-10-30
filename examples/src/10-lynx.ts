import { createHost, definePlugin, extensionPoint, service, type ContributionView } from "dougong";
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";
import { actionActivation, type ActionDeclaration } from "./action-declaration.js";
import { exampleResult, type ExampleResult } from "./example.js";

interface Filesystem {
  read(path: string): Promise<string>;
}
interface WorkspaceState {
  readonly id: string;
  readonly root: string;
}
type Command = ActionDeclaration & { readonly run: () => Promise<string> };
const explorerName = "examples.lynx.explorer";
const openExplorer = Object.freeze({ id: "explorer.open", title: "Open Explorer" });
const explorerActions: ReadonlyArray<ActionDeclaration> = Object.freeze([openExplorer]);
interface Panel {
  readonly id: string;
  readonly title: string;
}
interface CommandCatalog {
  list(): ReadonlyArray<{ readonly id: string; readonly title: string }>;
  run(id: string): Promise<string>;
}

const FILESYSTEM = service<Filesystem>("examples/lynx/filesystem");
const COMMAND_CATALOG = service<CommandCatalog>("examples/lynx/command-catalog");
const COMMANDS = extensionPoint<Command>("examples/lynx/commands");
const PANELS = extensionPoint<Panel>("examples/lynx/panels");
const workspaceState = (workspace: string) =>
  service<WorkspaceState>(`examples/lynx/workspaces/${encodeURIComponent(workspace)}/state`);
const MAIN_WORKSPACE = workspaceState("main");

// Business command identity belongs to this catalog; Core owns only contribution identity.
function commandEntry(commands: ContributionView<Command>, id: string) {
  const matches = [...commands.get()].filter(([, command]) => command.id === id);
  if (matches.length > 1) throw new TypeError(`Duplicate command '${id}'`);
  const match = matches[0];
  if (!match) throw new Error(`Command '${id}' is unavailable`);
  return match[0];
}

function explorerPlugin(title: string, relativePath: string) {
  return definePlugin({
    name: explorerName,
    requires: { filesystem: FILESYSTEM, workspace: MAIN_WORKSPACE },
    setup({ deps, contributions }) {
      for (const action of explorerActions)
        contributions.add(COMMANDS, action.id, {
          ...action,
          run: () => deps.filesystem.read(`${deps.workspace.root}/${relativePath}`),
        });
      contributions.add(PANELS, "explorer", { id: "explorer", title });
    },
  });
}

export async function lynxScenario(): Promise<ExampleResult> {
  let workspacePanels!: ContributionView<Panel>;
  let workspaceRoot = "";
  const filesystem = definePlugin({
    name: "examples.lynx.adapter.filesystem",
    provides: { filesystem: FILESYSTEM },
    setup: () => ({ filesystem: { read: async (path: string) => `contents:${path}` } }),
  });
  const catalog = definePlugin({
    name: "examples.lynx.command-catalog",
    requires: { commands: COMMANDS },
    provides: { catalog: COMMAND_CATALOG },
    setup({ deps }) {
      return {
        catalog: {
          list: () =>
            Object.freeze(
              [...deps.commands.get().values()].map(({ id, title }) =>
                Object.freeze({ id, title }),
              ),
            ),
          run: (id: string) =>
            deps.commands.use(commandEntry(deps.commands, id), (command) => command.run()),
        },
      };
    },
  });
  const state = definePlugin({
    name: "examples.lynx.workspace-state",
    provides: { workspace: MAIN_WORKSPACE },
    setup: () => ({ workspace: { id: "main", root: "/workspace" } }),
  });
  const shell = definePlugin({
    name: "examples.lynx.workspace-shell",
    requires: { panels: PANELS, workspace: MAIN_WORKSPACE },
    setup({ deps }) {
      workspacePanels = deps.panels;
      workspaceRoot = deps.workspace.root;
    },
  });
  const host = createHost({
    name: "lynx-example",
    groups: [{ id: "workspace-main" }],
    installations: [
      { id: "filesystem", plugin: filesystem },
      { id: "catalog", plugin: catalog },
      { id: "workspace-state", plugin: state, groupId: "workspace-main" },
      { id: "workspace-shell", plugin: shell, groupId: "workspace-main" },
    ],
  });
  await host.start();
  const platform = createPlatform({
    id: "workspace-extensions",
    host,
    apiVersion: "1.0.0",
    authorizer: new PermissionSet(["filesystem:read"]),
    loader: new MemoryLoader(
      new Map([
        ["explorer-v1", { default: explorerPlugin("Explorer", "README.md") }],
        ["explorer-v2", { default: explorerPlugin("Files", "GUIDE.md") }],
      ]),
    ),
  });
  const artifact = (version: string, reference: string) =>
    platform.catalog.add({
      revision: reference,
      manifest: {
        name: explorerName,
        version,
        activation: explorerActions.map(actionActivation),
        permissions: ["filesystem:read"],
      },
      reference,
    });
  const explorer = await platform.select(artifact("1.0.0", "explorer-v1"));
  const before = await host.use(COMMAND_CATALOG, (commands) => commands.list().length);
  await platform.trigger(actionActivation(openExplorer));
  const firstOutput = await host.use(COMMAND_CATALOG, (commands) => commands.run(openExplorer.id));
  await platform.select(artifact("1.1.0", "explorer-v2"));
  await platform.activate([explorer]);
  const secondOutput = await host.use(COMMAND_CATALOG, (commands) => commands.run(openExplorer.id));
  const panelTitle = [...workspacePanels.get().values()][0]?.title;

  await platform[Symbol.asyncDispose]();
  const workspace = host.group("workspace-main");
  if (!workspace) throw new Error("Workspace ownership group is missing");
  const remove = host.change();
  remove.removeGroup(workspace);
  await host.apply(await host.plan(remove));
  const remainingCommands = await host.use(COMMAND_CATALOG, (commands) => commands.list().length);
  let workspaceViewDisposed = false;
  try {
    workspacePanels.get();
  } catch {
    workspaceViewDisposed = true;
  }
  await host.stop();
  return exampleResult({
    id: "10",
    stage: "applications",
    title: "Lynx: a domain catalog, workspace ownership and updates in place",
    introduces: ["domain-catalog", "workspace-ownership", "registration-update"],
    facts: [
      "Command uniqueness belongs to CommandCatalog; invocation borrows the contributing Instance.",
      `The workspace shell bound to '${workspaceRoot}' with ${before} executable commands before activation.`,
      `An update retained the Registration identity while replacing its implementation: '${firstOutput}' → '${secondOutput}', panel now '${panelTitle}'.`,
      "A root-level catalog saw the Group's consumers and external contributions without implicit scope lookup.",
      `Removing the workspace released its subtree: ${remainingCommands} commands left, its view disposed = ${workspaceViewDisposed}.`,
    ],
  });
}
