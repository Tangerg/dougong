import { createHost, definePlugin, service } from "dougong";
import { exampleResult, type ExampleResult } from "./example.js";

interface Clock {
  now(): string;
}

const CLOCK = service<Clock>("examples/basics/clock");

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
      trace.push(`plugin:${ctx.deps.clock.now()}`);
    },
  });

  const host = createHost({
    name: "service-basics",
    installations: [
      { id: "greeter", plugin: greeterPlugin },
      { id: "clock", plugin: clockPlugin },
    ],
  });
  await host.start();

  trace.push(`host:${await host.use(CLOCK, (clock) => clock.now())}`);
  await host.stop();

  return exampleResult({
    id: "01",
    stage: "atoms",
    title: "A stable Service and the declaration that reaches it",
    introduces: ["service", "provides", "requires", "host.use"],
    facts: [
      "The provider started before its consumer even though it was installed second.",
      `Observed ${trace.join(" → ")}.`,
      "Plugins read declared aliases; host.use() borrows one running generation.",
    ],
  });
}
