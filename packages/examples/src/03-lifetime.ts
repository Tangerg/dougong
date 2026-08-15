import { createApp, definePlugin, type LifetimeContext } from "dougong";
import { exampleResult, whenAborted, type ExampleResult } from "./example";

/**
 * Lifetime is the only ownership primitive. Cleanups, child Lifetimes and
 * background tasks all hang off one tree, and the tree is released in reverse.
 */
export async function lifetimeOwnership(): Promise<ExampleResult> {
  const trace: string[] = [];
  let session!: LifetimeContext;

  const editorPlugin = definePlugin({
    name: "examples.lifetime.editor",
    setup(ctx) {
      // Acquire, then immediately declare how to release. The window is built
      // on the index, so teardown must close the window first.
      trace.push("open:index");
      ctx.cleanup(() => trace.push("close:index"));
      trace.push("open:window");
      ctx.cleanup(() => trace.push("close:window"));

      // A child Lifetime is an ownership subtree with its own cancellation
      // edge. Disposing it releases exactly its own resources and nothing else.
      trace.push("open:session");
      session = ctx.lifetime("session");
      session.cleanup(() => trace.push("close:session"));
      session.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:session-watcher");
      });

      // A task owned by the plugin itself outlives the session.
      ctx.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:editor-watcher");
      });
    },
  });

  const app = createApp({ name: "lifetime" });
  app.install(editorPlugin);
  await app.start();
  const acquired = [...trace];

  await session.dispose();
  const afterSession = trace.slice(acquired.length);

  await app.stop();
  const afterStop = trace.slice(acquired.length + afterSession.length);

  return exampleResult({
    id: "03",
    stage: "atoms",
    title: "Structured ownership: cleanups, child Lifetimes and tasks",
    introduces: ["cleanup", "child-lifetime", "spawn", "abort-signal"],
    facts: [
      `Setup acquired ${acquired.join(" → ")}.`,
      `Disposing the child released only its own subtree: ${afterSession.join(" → ")}.`,
      `Stopping released the rest in reverse: ${afterStop.join(" → ")}.`,
      "The window was opened after the index and closed before it — teardown mirrors construction.",
      "No task polled a flag: spawn() hands it an AbortSignal that the owning Lifetime aborts.",
    ],
  });
}
