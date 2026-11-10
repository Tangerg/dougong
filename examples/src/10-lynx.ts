import {
  createResourceAuthority,
  asyncDisposeSymbol,
  createHost,
  definePlugin,
  extensionPoint,
  service,
  type ContributionView,
} from "dougong";
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";
import { actionActivation, type ActionDeclaration } from "./action-declaration.js";
import { exampleResult, expectFailure, type ExampleResult } from "./example.js";

const resourceAuthority = createResourceAuthority();

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
  readonly title: string;
}
interface CommandCatalog {
  list(): Promise<ReadonlyArray<ActionDeclaration>>;
  run(id: string): Promise<string>;
}

const FILESYSTEM = service<Filesystem>("examples/lynx/filesystem");
const COMMAND_CATALOG = service<CommandCatalog>("examples/lynx/command-catalog");
const COMMANDS = extensionPoint<Command>("examples/lynx/commands");
const PANELS = extensionPoint<Panel>("examples/lynx/panels");
const workspaceState = (workspace: string) =>
  service<WorkspaceState>(`examples/lynx/workspaces/${encodeURIComponent(workspace)}/state`);
const mainWorkspace: WorkspaceState = Object.freeze({ id: "main", root: "/workspace" });
const workspaceGroupId = `workspace-${mainWorkspace.id}`;
const MAIN_WORKSPACE = workspaceState(mainWorkspace.id);

// Business command identity belongs to this catalog; Core owns only contribution identity.
async function commandEntries(commands: ContributionView<Command>) {
  const entries = await Promise.all(
    commands
      .get()
      .map((entry) =>
        commands.use(entry, ({ id, title }) => ({ entry, action: Object.freeze({ id, title }) })),
      ),
  );
  return entries.map(({ value }) => value);
}

function explorerPlugin(title: string, relativePath: string) {
  return definePlugin({
    name: explorerName,
    requires: { filesystem: FILESYSTEM, workspace: MAIN_WORKSPACE },
    setup({ dependencies, contributions }) {
      for (const action of explorerActions)
        contributions.add(COMMANDS, action.id, {
          ...action,
          run: () => dependencies.filesystem.read(`${dependencies.workspace.root}/${relativePath}`),
        });
      contributions.add(PANELS, "explorer", { title });
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
    setup({ dependencies }) {
      return {
        catalog: {
          list: async () =>
            Object.freeze(
              (await commandEntries(dependencies.commands)).map(({ action }) => action),
            ),
          async run(id: string) {
            const matches = (await commandEntries(dependencies.commands)).filter(
              ({ action }) => action.id === id,
            );
            if (matches.length > 1) throw new TypeError(`Duplicate command '${id}'`);
            const match = matches[0];
            if (!match) throw new Error(`Command '${id}' is unavailable`);
            const { value: output } = await dependencies.commands.use(match.entry, (command) => {
              if (command.id !== id) throw new Error(`Command '${id}' changed before invocation`);
              return command.run();
            });
            return output;
          },
        },
      };
    },
  });
  const state = definePlugin({
    name: "examples.lynx.workspace-state",
    provides: { workspace: MAIN_WORKSPACE },
    setup: () => ({ workspace: mainWorkspace }),
  });
  const shell = definePlugin({
    name: "examples.lynx.workspace-shell",
    requires: { panels: PANELS, workspace: MAIN_WORKSPACE },
    setup({ dependencies }) {
      workspacePanels = dependencies.panels;
      workspaceRoot = dependencies.workspace.root;
    },
  });
  const host = createHost({
    resourceAuthority,
    name: "lynx-example",
    groups: [{ id: workspaceGroupId }],
    installations: [
      { id: "filesystem", plugin: filesystem },
      { id: "catalog", plugin: catalog },
      { id: "workspace-state", plugin: state, groupId: workspaceGroupId },
      { id: "workspace-shell", plugin: shell, groupId: workspaceGroupId },
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
  const [explorer] = await platform.select([artifact("1.0.0", "explorer-v1")]);
  const { value: before } = await host.use(
    COMMAND_CATALOG,
    async (commands) => (await commands.list()).length,
  );
  await platform.trigger(actionActivation(openExplorer));
  const { value: firstOutput } = await host.use(COMMAND_CATALOG, (commands) =>
    commands.run(openExplorer.id),
  );
  await platform.select([artifact("1.1.0", "explorer-v2")]);
  await platform.activate([explorer]);
  const { value: secondOutput } = await host.use(COMMAND_CATALOG, (commands) =>
    commands.run(openExplorer.id),
  );
  const panel = workspacePanels.get()[0];
  if (panel === undefined) throw new Error("Explorer did not publish its workspace panel");
  const { value: panelTitle } = await workspacePanels.use(panel, (value) => value.title);

  await platform[asyncDisposeSymbol]();
  const workspace = host.group(workspaceGroupId);
  if (!workspace) throw new Error("Workspace ownership group is missing");
  const remove = host.change();
  remove.removeGroup(workspace);
  await host.apply(await host.plan(remove));
  const { value: remainingCommands } = await host.use(
    COMMAND_CATALOG,
    async (commands) => (await commands.list()).length,
  );
  const closedView = await expectFailure("LIFETIME_DISPOSED", workspacePanels.get);
  await host.stop();
  return exampleResult({
    id: "10",
    title: "Lynx: a domain catalog, workspace ownership and updates in place",
    facts: [
      "Command uniqueness belongs to CommandCatalog; invocation borrows the contributing Instance.",
      `The workspace shell bound to '${workspaceRoot}' with ${before} executable commands before activation.`,
      `An update retained the Registration identity while replacing its implementation: '${firstOutput}' → '${secondOutput}', panel now '${panelTitle}'.`,
      "A root-level catalog saw the Group's consumers and external contributions without implicit scope lookup.",
      `Removing the workspace left ${remainingCommands} commands and its panel view reports ${closedView.code}.`,
    ],
  });
}
