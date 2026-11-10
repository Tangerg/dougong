import {
  createResourceAuthority,
  asyncDisposeSymbol,
  createHost,
  definePlugin,
  extensionPoint,
  type ContributionView,
} from "dougong";
import { createPlatform, MemoryLoader, PermissionSet } from "@dougongjs/platform";
import { actionActivation, type ActionDeclaration } from "./action-declaration.js";
import { exampleResult, type ExampleResult } from "./example.js";

const resourceAuthority = createResourceAuthority();

type Command = ActionDeclaration & { readonly run: () => string };
const remoteAction = Object.freeze({ id: "remote.run", title: "Run remote command" });
const actions: ReadonlyArray<ActionDeclaration> = Object.freeze([remoteAction]);
const COMMANDS = extensionPoint<Command>("examples/platform/commands");

export async function lazyPlatform(): Promise<ExampleResult> {
  let commands!: ContributionView<Command>;
  const shell = definePlugin({
    name: "examples.platform.shell",
    requires: { commands: COMMANDS },
    setup({ dependencies }) {
      commands = dependencies.commands;
    },
  });
  const active = definePlugin({
    name: "examples.platform.remote-command",
    setup({ contributions }) {
      for (const action of actions)
        contributions.add(COMMANDS, action.id, { ...action, run: () => "loaded" });
    },
  });
  const host = createHost({
    resourceAuthority,
    name: "lazy-platform",
    installations: [{ id: "shell", plugin: shell }],
  });
  await host.start();
  const platform = createPlatform({
    id: "commands",
    host,
    apiVersion: "1.0.0",
    authorizer: new PermissionSet(["network"]),
    loader: new MemoryLoader(new Map([["remote", { default: active }]])),
  });
  const [registration] = await platform.select([
    platform.catalog.add({
      revision: "remote-content-1",
      manifest: {
        name: active.name,
        version: "1.0.0",
        activation: actions.map(actionActivation),
        permissions: ["network"],
      },
      reference: "remote",
    }),
  ]);
  const preview = platform.preview([registration]);
  const before = commands.get().length;
  await platform.trigger(actionActivation(remoteAction));
  const commandId = commands.get()[0];
  if (!commandId) throw new Error("Activation did not publish the command");
  const { value: output } = await commands.use(commandId, (command) => command.run());
  const after = commands.get().length;
  await platform.remove(registration);
  await platform[asyncDisposeSymbol]();
  await host.stop();
  return exampleResult({
    id: "08",
    title: "Code that arrives from outside the build",
    facts: [
      `The data-only preview described ${preview.selections.length} selection with ${preview.deferred.length} deferred checks.`,
      `Before activation the ExtensionPoint held ${before} executable commands; loading published ${after}.`,
      `The borrowed command returned '${output}', and its implementation came from the committed Artifact origin.`,
      "One action declaration supplied discovery metadata, contribution identity and derived activation events.",
      "Manifest, permission and loading policy stayed in Platform; capability semantics stayed in Core.",
    ],
  });
}
