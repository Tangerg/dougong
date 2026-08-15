import {
  createHost,
  definePlugin,
  extensionPoint,
  service,
  type LifetimeSnapshot,
  type Task,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Panel {
  readonly id: string;
}

interface Workbench {
  readonly title: string;
}

const PANELS = extensionPoint<Panel>("examples/diagnostics/panels");
const WORKBENCH = service<Workbench>("examples/diagnostics/workbench");

/** Renders one ownership tree the way a devtools panel would. */
function describe(node: LifetimeSnapshot): string {
  const own = `${node.label}[${node.phase} c${node.contributions} t${node.tasks} k${node.cleanups}]`;
  if (!node.children.length) return own;
  return `${own}(${node.children.map(describe).join(", ")})`;
}

/** An immutable read model: it reports what is running, and cannot steer it. */
export async function diagnostics(): Promise<ExampleResult> {
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let indexing!: Task<void>;

  const workbenchPlugin = definePlugin({
    name: "examples.diagnostics.workbench",
    provides: { workbench: WORKBENCH },
    setup(ctx) {
      ctx.contribute(PANELS, "outline", { id: "outline" });
      const session = ctx.lifetime("session");
      session.cleanup(() => undefined);
      session.contribute(PANELS, "problems", { id: "problems" });
      indexing = ctx.spawn(() => gate);
      return { workbench: { title: "Workbench" } };
    },
  });

  const shellPlugin = definePlugin({
    name: "examples.diagnostics.shell",
    requires: { workbench: WORKBENCH, panels: PANELS },
    setup: () => undefined,
  });

  const host = createHost({ name: "diagnostics" });
  const installation = host.install(workbenchPlugin);
  host.install(shellPlugin);

  // The view is a `get()` + `subscribe()` pair — the same protocol an
  // ContributionView and a signal expose, so `observe()` accepts it unchanged.
  const revisions: number[] = [];
  const subscription = host.diagnostics.subscribe(() => {
    revisions.push(host.diagnostics.get().revision);
  });

  await host.start();

  const snapshot = host.diagnostics.get();
  const workbench = snapshot.installations.get(installation.id);
  const shell = [...snapshot.installations.values()].find((entry) => entry.id !== installation.id);
  if (!workbench?.lifetime || !shell)
    throw new TypeError("Diagnostics did not report both Installations");
  const lifetime = workbench.lifetime;
  const busy = lifetime.get();

  // A finished task detaches itself from its owner. Nothing has to be swept.
  openGate();
  await indexing.result;
  const settled = lifetime.get();

  subscription.dispose();
  await host.stop();

  // The tree is gone, but a view kept from before still reads its final
  // state — as plain data, without holding the Host alive.
  const final = lifetime.get();
  let acceptsNewSubscribers = true;
  try {
    lifetime.subscribe(() => undefined).dispose();
  } catch {
    acceptsNewSubscribers = false;
  }

  return exampleResult({
    id: "07",
    stage: "composition",
    title: "Reading the running system without being able to steer it",
    introduces: [
      "diagnostics-view",
      "lifetime-snapshot",
      "terminal-detachment",
      "view-finalization",
    ],
    facts: [
      `The Host snapshot reported ${snapshot.installations.size} Installations at status '${snapshot.status}', revision ${snapshot.revision}.`,
      `Declarations are readable as data: the shell requires [${shell.requires.join(", ")}], the workbench provides [${workbench.provides.join(", ")}].`,
      `Ownership is a labeled tree: ${describe(busy)}.`,
      `The task finished and detached itself: tasks ${busy.tasks} → ${settled.tasks}, with the plugin still active.`,
      `${revisions.length} committed revisions reached the subscriber; no uncommitted state was ever visible.`,
      `After stop the view finalized to phase '${final.phase}' and accepts new subscribers = ${acceptsNewSubscribers}.`,
    ],
  });
}
