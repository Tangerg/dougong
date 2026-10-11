import { createHost, definePlugin, type LifetimeContext } from "dougong";
import { exampleResult, whenAborted, type ExampleResult } from "./example";

export async function lifetimeOwnership(): Promise<ExampleResult> {
  const trace: string[] = [];
  let session!: LifetimeContext;

  const editorPlugin = definePlugin({
    name: "examples.lifetime.editor",
    setup(ctx) {
      // The window depends on the index, so teardown must close the window first.
      trace.push("open:index");
      ctx.cleanup(() => trace.push("close:index"));
      trace.push("open:window");
      ctx.cleanup(() => trace.push("close:window"));

      trace.push("open:session");
      session = ctx.lifetime("session");
      session.cleanup(() => trace.push("close:session"));
      session.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:session-watcher");
      });

      ctx.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:editor-watcher");
      });
    },
  });

  const host = createHost({ name: "lifetime" });
  host.install(editorPlugin);
  await host.start();
  const acquired = [...trace];

  await session.dispose();
  const afterSession = trace.slice(acquired.length);

  await host.stop();
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
