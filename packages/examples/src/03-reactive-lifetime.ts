import { batch, computed, createApp, definePlugin, observe, signal } from "dougong";
import { nextTurn, type ExampleResult } from "./example";

/** Signal models values; observe rebuilds explicitly owned resources for each value. */
export async function reactiveLifetime(): Promise<ExampleResult> {
  const origin = signal("https://api.example");
  const account = signal("alice");
  const endpoint = computed(() => `${origin.get()}/events/${account.get()}`);
  const trace: string[] = [];

  const connectionPlugin = definePlugin({
    name: "examples.reactive.connection",
    setup(ctx) {
      observe(ctx, endpoint, (url, lifetime) => {
        trace.push(`connect:${url}`);
        lifetime.cleanup(() => trace.push(`disconnect:${url}`));
      });
    },
  });

  const app = createApp({ name: "reactive-lifetime" });
  app.install(connectionPlugin);
  await app.start();

  batch(() => {
    origin.set("https://edge.example");
    account.set("bob");
  });
  await nextTurn();
  await nextTurn();
  await app.stop();

  return Object.freeze({
    id: "03",
    title: "Signals composed with explicit Lifetime ownership",
    facts: Object.freeze([
      "computed() performs pure value derivation; it does not own resources.",
      "observe() disposes the previous child Lifetime before building the next one.",
      `Lifecycle trace: ${trace.join(" → ")}.`,
    ]),
  });
}
