import { createResourceAuthority, createHost, definePlugin } from "dougong";
import { batch, computed, observe, signal } from "@dougongjs/reactive";
import { exampleResult, nextTurn, type ExampleResult } from "./example.js";

const resourceAuthority = createResourceAuthority();

export async function reactiveLifetime(): Promise<ExampleResult> {
  const origin = signal("https://api.example");
  const account = signal("alice");
  const endpoint = computed(() => `${origin.get()}/events/${account.get()}`);
  const trace: string[] = [];

  const connectionPlugin = definePlugin({
    name: "examples.reactive.connection",
    setup(context) {
      observe(context.lifetime, endpoint, (url, lifetime) => {
        trace.push(`connect:${url}`);
        lifetime.defer(() => trace.push(`disconnect:${url}`));
      });
    },
  });

  const host = createHost({
    resourceAuthority,
    name: "reactive-lifetime",
    installations: [{ id: "connection", plugin: connectionPlugin }],
  });
  await host.start();

  batch(() => {
    origin.set("https://edge.example");
    account.set("bob");
  });
  await nextTurn();
  await nextTurn();

  const connects = trace.filter((entry) => entry.startsWith("connect:")).length;
  await host.stop();
  const disconnects = trace.filter((entry) => entry.startsWith("disconnect:")).length;

  return exampleResult({
    id: "04",
    title: "Values change, resources are rebuilt",
    facts: [
      `Two writes inside one batch() produced ${connects - 1} rebuild, not two.`,
      "observe() disposed the previous child Lifetime before building the next one.",
      `Every connection was closed: ${connects} opened, ${disconnects} closed.`,
      `Lifecycle trace: ${trace.join(" → ")}.`,
    ],
  });
}
