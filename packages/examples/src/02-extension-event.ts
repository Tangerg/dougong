import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type Contribution,
  type ContributionView,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Command {
  readonly id: string;
  run(): Promise<void>;
}

interface CommandExecuted {
  readonly id: string;
}

// One Service has one provider. One ExtensionPoint has any number of contributors.
const COMMANDS = extensionPoint<Command>("examples/commands");
// An Event is a fact that already happened. It stores nothing.
const COMMAND_EXECUTED = event<CommandExecuted>("examples/command-executed");

/** Why an open set and a transient fact cannot stand in for each other. */
export async function extensionAndEvent(): Promise<ExampleResult> {
  const executed: string[] = [];
  let commands!: ContributionView<Command>;
  let contribution!: Contribution<Command>;

  const shellPlugin = definePlugin({
    name: "examples.commands.shell",
    requires: { commands: COMMANDS },
    setup(ctx) {
      // A live view, not a copy: later contributions appear without a restart.
      commands = ctx.commands;
      ctx.on(COMMAND_EXECUTED, ({ id }) => executed.push(id));
    },
  });

  const helloPlugin = definePlugin({
    name: "examples.commands.hello",
    setup(ctx) {
      // The returned Contribution is the contributor's own withdrawal right.
      contribution = ctx.contribute(COMMANDS, "hello", {
        id: "hello",
        run: () => ctx.emit(COMMAND_EXECUTED, { id: "hello" }),
      });
    },
  });

  const host = createHost({ name: "extension-event" });
  host.install(shellPlugin);
  host.install(helloPlugin);
  await host.start();

  const published = commands.get().size;
  const command = [...commands.get().values()][0];
  if (!command) throw new TypeError("The command contribution was not published");
  await command.run();

  // Withdrawing early is ordinary: the ExtensionPoint is a set, not a registration log.
  contribution.dispose();
  const remaining = commands.get().size;
  await host.stop();

  return exampleResult({
    id: "02",
    stage: "atoms",
    title: "An open contribution set and a transient fact",
    introduces: [
      "extension-point",
      "contribute",
      "contribution-view",
      "event",
      "contribution-dispose",
    ],
    facts: [
      `The shell read a live, immutable Map holding ${published} contribution.`,
      `The Event delivered ${executed.join(", ")} and then kept nothing — it is not a query API.`,
      `Disposing the Contribution left ${remaining} entries, without touching the contributor.`,
    ],
  });
}
