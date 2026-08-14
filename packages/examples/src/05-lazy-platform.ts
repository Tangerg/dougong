import {
  createApp,
  createPlatform,
  definePlugin,
  extension,
  MemoryPluginLoader,
  PermissionSet,
  type ExtensionView,
} from "dougong";
import type { ExampleResult } from "./example";

interface Command {
  readonly id: string;
  readonly run?: () => string;
}

const COMMANDS = extension<Command>("examples/platform/commands");

/** Platform compiles manifest, loading and activation into ordinary Core operations. */
export async function lazyPlatform(): Promise<ExampleResult> {
  let commands!: ExtensionView<Command>;
  const shellPlugin = definePlugin({
    name: "examples.platform.shell",
    requires: { commands: COMMANDS },
    setup(ctx) {
      commands = ctx.commands;
    },
  });
  const placeholder = definePlugin({
    name: "examples.platform.remote-command",
    setup(ctx) {
      ctx.contribute(COMMANDS, "remote", { id: "remote.run" });
    },
  });
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

  await managed.remove();
  await platform.dispose();
  await app.stop();

  return Object.freeze({
    id: "05",
    title: "Manifest-driven lazy activation without a second runtime",
    facts: Object.freeze([
      `Placeholder command '${before?.id}' was visible before module loading.`,
      `Activation atomically replaced it with executable output '${output}'.`,
      "Permission and loading policy stayed in Platform; capability semantics stayed in Core.",
    ]),
  });
}
