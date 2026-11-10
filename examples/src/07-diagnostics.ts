import {
  createResourceAuthority,
  disposeSymbol,
  createHost,
  definePlugin,
  extensionPoint,
  service,
  type LifetimeSnapshot,
  type Task,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example.js";

const resourceAuthority = createResourceAuthority();

interface Panel {
  readonly id: string;
}
interface Workbench {
  readonly title: string;
}
const PANELS = extensionPoint<Panel>("examples/diagnostics/panels");
const WORKBENCH = service<Workbench>("examples/diagnostics/workbench");

function describe(node: LifetimeSnapshot): string {
  const own = `${node.label}[${node.phase} p${node.publications} t${node.tasks} k${node.cleanups}]`;
  return node.children.length ? `${own}(${node.children.map(describe).join(", ")})` : own;
}

export async function diagnostics(): Promise<ExampleResult> {
  const gate = Promise.withResolvers<void>();
  let indexing!: Task<void>;
  const workbenchPlugin = definePlugin({
    name: "examples.diagnostics.workbench",
    provides: { workbench: WORKBENCH },
    setup({ lifetime, contributions }) {
      const panel: Panel = { id: "outline" };
      contributions.add(PANELS, panel.id, panel);
      const session = lifetime.child("session");
      session.defer(() => undefined);
      indexing = lifetime.spawn(() => gate.promise);
      return { workbench: { title: "Workbench" } };
    },
  });
  const shellPlugin = definePlugin({
    name: "examples.diagnostics.shell",
    requires: { workbench: WORKBENCH, panels: PANELS },
    setup: () => undefined,
  });
  const host = createHost({
    resourceAuthority,
    name: "diagnostics",
    installations: [
      { id: "workbench", plugin: workbenchPlugin },
      { id: "shell", plugin: shellPlugin },
    ],
  });
  const revisions: number[] = [];
  const subscription = host.diagnostics.subscribe(() =>
    revisions.push(host.diagnostics.get().stateRevision),
  );
  await host.start();
  const snapshot = host.diagnostics.get();
  const busy = snapshot.installations.find((item) => item.id === "workbench")?.lifetime;
  if (!busy) throw new Error("Diagnostics did not report the running Instance");
  gate.resolve();
  await indexing.result;
  const settled = host.diagnostics
    .get()
    .installations.find((item) => item.id === "workbench")?.lifetime;
  if (!settled) throw new Error("Running Instance disappeared after its task finished");
  subscription[disposeSymbol]();
  await host.stop();
  const stopped = host.diagnostics.get();
  return exampleResult({
    id: "07",
    title: "Reading the running system without being able to steer it",
    facts: [
      `The snapshot reported ${snapshot.installations.length} Installations at '${snapshot.status}', state revision ${snapshot.stateRevision}.`,
      `Ownership is a labeled tree: ${describe(busy)}.`,
      `The task finished and detached itself: tasks ${busy.tasks} → ${settled.tasks}, with the plugin still active.`,
      `${revisions.length} notifications included resource changes without inventing extra state revisions.`,
      `After stop the snapshot reports '${stopped.status}', retaining ${stopped.installations.length} declarations and no live Lifetime references.`,
    ],
  });
}
