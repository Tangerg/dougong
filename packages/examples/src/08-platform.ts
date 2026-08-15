import {
  createApp,
  createPlatform,
  definePlugin,
  extension,
  MemoryPluginLoader,
  PermissionSet,
  type ExtensionView,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Command {
  readonly id: string;
  readonly run?: () => string;
}

const COMMANDS = extension<Command>("examples/platform/commands");

/**
 * Everything so far was code the host compiled. Platform adds the four
 * concerns that appear when code arrives from outside the build — declaration,
 * authorization, loading, activation — and compiles them into the same Core
 * install / update / remove used in chapters 05 and 06.
 */
export async function lazyPlatform(): Promise<ExampleResult> {
  let commands!: ExtensionView<Command>;

  const shellPlugin = definePlugin({
    name: "examples.platform.shell",
    requires: { commands: COMMANDS },
    setup(ctx) {
      commands = ctx.commands;
    },
  });

  // Host-authored: it makes the command visible in the menu before any
  // external module has been fetched.
  const placeholder = definePlugin({
    name: "examples.platform.remote-command",
    setup(ctx) {
      ctx.contribute(COMMANDS, "remote", { id: "remote.run" });
    },
  });

  // The real implementation, shipped separately.
  const active = definePlugin({
    name: "examples.platform.remote-command",
    setup(ctx) {
      ctx.contribute(COMMANDS, "remote", {
        id: "remote.run",
        run: () => "loaded",
      });
    },
  });

  const app = createApp({ name: "lazy-platform" });
  app.install(shellPlugin);
  await app.start();

  const platform = createPlatform({
    container: app,
    apiVersion: "1.0.0",
    permissions: new PermissionSet(["network"]),
    loader: new MemoryPluginLoader(new Map([["remote", { default: active }]])),
  });

  // Registration is admission, not execution. Nothing has been loaded yet.
  const managed = await platform.register({
    manifest: {
      name: "examples.platform.remote-command",
      version: "1.0.0",
      activation: ["command:remote.run"],
      permissions: ["network"],
    },
    reference: "remote",
    placeholder,
  });

  const before = [...commands.get().values()][0];
  await platform.trigger("command:remote.run");
  const after = [...commands.get().values()][0];
  const output = after?.run?.();
  const stillOne = commands.get().size;

  await managed.remove();
  await platform.dispose();
  await app.stop();

  return exampleResult({
    id: "08",
    stage: "composition",
    title: "Code that arrives from outside the build",
    introduces: ["manifest", "permissions", "placeholder", "activation"],
    facts: [
      `The placeholder made '${before?.id}' visible before any module was fetched.`,
      `The activation event swapped it for an executable one in a single committed step: '${output}'.`,
      `Consumers never saw two entries for the same key — the Extension held ${stillOne} throughout.`,
      "Manifest, permission and loading policy stayed in Platform; capability semantics stayed in Core.",
    ],
  });
}
