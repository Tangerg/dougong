import {
  disposeSymbol,
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type Contribution,
  type ContributionView,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example.js";

interface Command {
  readonly id: string;
  run(): Promise<void>;
}

interface CommandExecuted {
  readonly id: string;
}

const COMMANDS = extensionPoint<Command>("examples/commands");
const COMMAND_EXECUTED = event<CommandExecuted>("examples/command-executed");

export async function extensionAndEvent(): Promise<ExampleResult> {
  const executed: string[] = [];
  let commands!: ContributionView<Command>;
  let contribution!: Contribution<Command>;

  const shellPlugin = definePlugin({
    name: "examples.commands.shell",
    requires: { commands: COMMANDS },
    setup(ctx) {
      commands = ctx.deps.commands;
      ctx.events.on(COMMAND_EXECUTED, ({ id }) => executed.push(id));
    },
  });

  const helloPlugin = definePlugin({
    name: "examples.commands.hello",
    setup(ctx) {
      contribution = ctx.contributions.add(COMMANDS, "hello", {
        id: "hello",
        run: () => ctx.events.emit(COMMAND_EXECUTED, { id: "hello" }),
      });
    },
  });

  const host = createHost({
    name: "extension-event",
    installations: [
      { id: "shell", plugin: shellPlugin },
      { id: "hello", plugin: helloPlugin },
    ],
  });
  await host.start();

  const published = commands.get().size;
  const commandId = commands.get().keys().next().value;
  if (!commandId) throw new TypeError("The command contribution was not published");
  await commands.use(commandId, (command) => command.run());

  contribution[disposeSymbol]();
  const remaining = commands.get().size;
  await host.stop();

  return exampleResult({
    id: "02",
    title: "An open contribution set and a transient fact",
    facts: [
      `The shell read a live, immutable Map holding ${published} contribution.`,
      `The Event delivered ${executed.join(", ")} and then kept nothing — it is not a query API.`,
      `Disposing the Contribution left ${remaining} entries, without touching the contributor.`,
    ],
  });
}
