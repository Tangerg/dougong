import { createApp, definePlugin, service } from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Clock {
  now(): string;
}

// A Contract is an identity, not an implementation. Nothing is registered here.
const CLOCK = service<Clock>("examples/basics/clock");

/** The smallest complete application: declare an identity, provide it, require it, run. */
export async function serviceBasics(): Promise<ExampleResult> {
  const trace: string[] = [];

  const clockPlugin = definePlugin({
    name: "examples.basics.clock",
    provides: { clock: CLOCK },
    setup: () => ({ clock: { now: () => "09:30" } }),
  });

  const greeterPlugin = definePlugin({
    name: "examples.basics.greeter",
    requires: { clock: CLOCK },
    setup(ctx) {
      // `ctx.clock` exists because the line above declared it. Reading anything
      // undeclared is a compile error, not a runtime surprise.
      trace.push(`plugin:${ctx.clock.now()}`);
    },
  });

  const app = createApp({ name: "service-basics" });
  // Installation order is not startup order. The declared Service edge is.
  app.install(greeterPlugin);
  app.install(clockPlugin);
  await app.start();

  trace.push(`host:${app.get(CLOCK).now()}`);
  await app.stop();

  return exampleResult({
    id: "01",
    stage: "atoms",
    title: "A stable Service and the declaration that reaches it",
    introduces: ["service", "provides", "requires", "app.get"],
    facts: [
      "The provider started before its consumer even though it was installed second.",
      `Observed ${trace.join(" → ")}.`,
      "Plugins read declared aliases; app.get() exists only for the host boundary.",
    ],
  });
}
