import { asyncDisposeSymbol, createHost, definePlugin, type ChildLifetime } from "dougong";
import { exampleResult, whenAborted, type ExampleResult } from "./example.js";

export async function lifetimeOwnership(): Promise<ExampleResult> {
  const trace: string[] = [];
  let session!: ChildLifetime;

  const editorPlugin = definePlugin({
    name: "examples.lifetime.editor",
    setup(ctx) {
      // The window depends on the index, so teardown must close the window first.
      trace.push("open:index");
      ctx.lifetime.defer(() => trace.push("close:index"));
      trace.push("open:window");
      ctx.lifetime.defer(() => trace.push("close:window"));

      trace.push("open:session");
      session = ctx.lifetime.child("session");
      session.defer(() => trace.push("close:session"));
      session.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:session-watcher");
      });

      ctx.lifetime.spawn(async (signal) => {
        await whenAborted(signal);
        trace.push("cancel:editor-watcher");
      });
    },
  });

  const host = createHost({
    name: "lifetime",
    installations: [{ id: "editor", plugin: editorPlugin }],
  });
  await host.start();
  const acquired = [...trace];

  await session[asyncDisposeSymbol]();
  const afterSession = trace.slice(acquired.length);

  await host.stop();
  const afterStop = trace.slice(acquired.length + afterSession.length);

  return exampleResult({
    id: "03",
    title: "Structured ownership: cleanups, child Lifetimes and tasks",
    facts: [
      `Setup acquired ${acquired.join(" → ")}.`,
      `Disposing the child released only its own subtree: ${afterSession.join(" → ")}.`,
      `Stopping released the rest in reverse: ${afterStop.join(" → ")}.`,
      "The window was opened after the index and closed before it — teardown mirrors construction.",
      "No task polled a flag: spawn() hands it an AbortSignal that the owning Lifetime aborts.",
    ],
  });
}
