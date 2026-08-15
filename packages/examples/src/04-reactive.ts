import { batch, computed, createApp, definePlugin, observe, signal } from "dougong";
import { exampleResult, nextTurn, type ExampleResult } from "./example";

/**
 * Signals model values. Chapter 03's Lifetime models resources. `observe()` is
 * the single seam between them: one value change, one resource rebuild.
 */
export async function reactiveLifetime(): Promise<ExampleResult> {
  const origin = signal("https://api.example");
  const account = signal("alice");
  // Pure derivation. A computed owns no resource and releases nothing.
  const endpoint = computed(() => `${origin.get()}/events/${account.get()}`);
  const trace: string[] = [];

  const connectionPlugin = definePlugin({
    name: "examples.reactive.connection",
    setup(ctx) {
      // The plugin's Lifetime owns the observation; each value gets a child
      // Lifetime that is disposed before the next one is built.
      observe(ctx, endpoint, (url, lifetime) => {
        trace.push(`connect:${url}`);
        lifetime.cleanup(() => trace.push(`disconnect:${url}`));
      });
    },
  });

  const app = createApp({ name: "reactive-lifetime" });
  app.install(connectionPlugin);
  await app.start();

  // Two writes, one coherent value, one rebuild. Without the batch the
  // intermediate `edge.example/events/alice` would have opened a connection.
  batch(() => {
    origin.set("https://edge.example");
    account.set("bob");
  });
  await nextTurn();
  await nextTurn();

  const connects = trace.filter((entry) => entry.startsWith("connect:")).length;
  await app.stop();
  const disconnects = trace.filter((entry) => entry.startsWith("disconnect:")).length;

  return exampleResult({
    id: "04",
    stage: "atoms",
    title: "Values change, resources are rebuilt",
    introduces: ["signal", "computed", "batch", "observe"],
    facts: [
      `Two writes inside one batch() produced ${connects - 1} rebuild, not two.`,
      "observe() disposed the previous child Lifetime before building the next one.",
      `Every connection was closed: ${connects} opened, ${disconnects} closed.`,
      `Lifecycle trace: ${trace.join(" → ")}.`,
    ],
  });
}
