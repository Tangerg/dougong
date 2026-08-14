import { createApp, definePlugin, service } from "dougong";
import type { ExampleResult } from "./example";

interface Clock {
  now(): string;
}

const CLOCK = service<Clock>("examples/basics/clock");

/** The smallest complete Dougong application: declare, provide, require, run. */
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
      trace.push(`plugin:${ctx.clock.now()}`);
    },
  });

  const app = createApp({ name: "service-basics" });
  // Installation order is not startup order. The Service edge is the truth.
  app.install(greeterPlugin);
  app.install(clockPlugin);
  await app.start();
  trace.push(`host:${app.get(CLOCK).now()}`);
  await app.stop();

  return Object.freeze({
    id: "01",
    title: "Stable Service dependencies",
    facts: Object.freeze([
      "The provider starts before its consumer even when installed later.",
      `Observed ${trace.join(" → ")}.`,
      "Plugins use declared aliases; app.get() is reserved for the host boundary.",
    ]),
  });
}
