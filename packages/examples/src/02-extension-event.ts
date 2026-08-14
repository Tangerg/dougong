import {
  createApp,
  definePlugin,
  event,
  extension,
  type Contribution,
  type ExtensionView,
} from "dougong";
import type { ExampleResult } from "./example";

interface Command {
  readonly id: string;
  run(): Promise<void>;
}

interface CommandExecuted {
  readonly id: string;
}

const COMMANDS = extension<Command>("examples/commands");
const COMMAND_EXECUTED = event<CommandExecuted>("examples/command-executed");

/** Extension stores current contributions; Event reports facts that already happened. */
export async function extensionAndEvent(): Promise<ExampleResult> {
  const executed: string[] = [];
  let commands!: ExtensionView<Command>;
  let contribution!: Contribution<Command>;

  const shellPlugin = definePlugin({
    name: "examples.commands.shell",
    requires: { commands: COMMANDS },
    setup(ctx) {
      commands = ctx.commands;
      ctx.on(COMMAND_EXECUTED, ({ id }) => executed.push(id));
    },
  });
  const helloPlugin = definePlugin({
    name: "examples.commands.hello",
    setup(ctx) {
      contribution = ctx.contribute(COMMANDS, "hello", {
        id: "hello",
        run: () => ctx.emit(COMMAND_EXECUTED, { id: "hello" }),
      });
    },
  });

  const app = createApp({ name: "extension-event" });
  app.install(shellPlugin);
  app.install(helloPlugin);
  await app.start();

  const command = [...commands.get().values()][0];
  if (!command) throw new TypeError("The command contribution was not published");
  await command.run();
  contribution.dispose();
  const remaining = commands.get().size;
  await app.stop();

  return Object.freeze({
    id: "02",
    title: "Open Extension contributions and transient Events",
    facts: Object.freeze([
      "The shell reads a live, immutable contribution Map.",
      `The Event recorded ${executed.join(", ")} without becoming a query API.`,
      `Early Contribution.dispose() updated the Extension to ${remaining} entries.`,
    ]),
  });
}
