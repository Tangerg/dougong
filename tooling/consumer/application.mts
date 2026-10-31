import {
  createHost,
  definePlugin,
  describePlugin,
  service,
  type LifetimeContext,
  type PlanReport,
} from "dougong";
import { ReadonlyMapSnapshot, SerialQueue } from "dougong/advanced";
import { bridge, computed } from "@dougongjs/reactive";
import type * as Reactive from "@dougongjs/reactive";
import { createPlatform, MemoryLoader } from "@dougongjs/platform";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const GREETING = service<{ greet(name: string): string }>("consumer/greeting");
const REMOTE = service<{ value: string }>("consumer/remote");
let owner!: LifetimeContext;
let released = 0;
let setups = 0;
const greeting = definePlugin({
  name: "consumer.greeting",
  provides: { greeting: GREETING },
  setup({ lifetime }) {
    setups++;
    owner = lifetime;
    lifetime.use({
      [Symbol.dispose]() {
        released++;
      },
    });
    return { greeting: { greet: (name) => `Hello, ${name}` } };
  },
});
const description = describePlugin(greeting);
assert(
  description.name === greeting.name && description.config.status === "none",
  "Packed declaration description differs",
);
assert(
  description.provides[0]?.id === GREETING.id && setups === 0,
  "Description executed setup or lost capability identity",
);
assert(
  JSON.stringify(description).includes("consumer/greeting"),
  "Description is not serializable data",
);
const host = createHost({ installations: [{ id: "greeting", plugin: greeting }] });
await host.start();
assert(
  (await host.use(GREETING, (value) => value.greet("consumer"))) === "Hello, consumer",
  "Packed core cannot provide a borrowed service",
);

const separateCopy = (await import(
  new URL("../node_modules/@fixture/reactive-copy/dist/index.js", import.meta.url).href
)) as typeof Reactive;
const foreign = separateCopy.signal(2);
const local = bridge(owner, foreign);
const doubled = computed(() => local.get() * 2);
assert(doubled.get() === 4, "Initial bridge value differs");
foreign.set(3);
assert(
  doubled.get() === 6,
  "Separate installed reactive copies do not interoperate through bridge",
);

const remote = definePlugin({
  name: "consumer.remote",
  requires: { greeting: GREETING },
  provides: { remote: REMOTE },
  setup({ deps }) {
    return { remote: { value: deps.greeting.greet("remote") } };
  },
});
const platform = createPlatform({
  id: "consumer-delivery",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["module", { default: remote }]])),
});
const selected = await platform.select(
  platform.catalog.add({
    revision: "remote-content-1",
    manifest: { name: remote.name, version: "1.0.0" },
    reference: "module",
  }),
);
assert(platform.preview([selected]).selections.length === 1, "Packed Platform preview differs");
await platform.activate([selected]);
assert(
  (await host.use(REMOTE, (value) => value.value)) === "Hello, remote",
  "Packed Platform activation did not use the packed core",
);
assert(selected.activeOrigin?.revision === "remote-content-1", "Execution origin did not commit");

const change = host.change();
const probe = definePlugin({ name: "consumer.probe", setup() {} });
change.install(probe, { id: "probe", origin: { kind: "fixture", revision: "probe-1" } });
const plan = await host.plan(change);
const report: PlanReport = plan.report;
assert(report.baseStateRevision === host.diagnostics.get().stateRevision, "Plan baseline differs");
assert(
  report.bindings.before.length === report.bindings.after.length,
  "Unchanged bindings were not projected before and after",
);
assert(
  report.publishOrder.includes("probe"),
  "Publication order omitted the affected installation",
);
const operation = report.operations.find((item) => item.kind === "install" && item.id === "probe");
assert(
  operation &&
    "after" in operation &&
    operation.after?.pluginName === probe.name &&
    operation.after.origin?.revision === "probe-1",
  "Plan declaration provenance is not reviewable",
);
assert(
  JSON.parse(JSON.stringify(report)).execution.atomicPublication === true,
  "Plan report is not serializable",
);
const applied = await host.apply(plan);
assert(
  applied.stateRevision === host.stateRevision && applied.affectedInstallations.includes("probe"),
  "Packed apply result omitted committed revision or affected installations",
);
assert(!("outcome" in applied), "Constant success tag escaped the packed API");
assert((await new SerialQueue().run(() => 7)) === 7, "Advanced entrypoint is not executable");
assert(new ReadonlyMapSnapshot([["one", 1]]).get("one") === 1, "Advanced map export differs");
await platform[Symbol.asyncDispose]();
await host[Symbol.asyncDispose]();
assert(released === 1, "Packed resource protocol failed to release exactly once");
assert(
  !("install" in host) && !("get" in host) && !("dispose" in host) && !("inspect" in host),
  "Retired Host mutation or disposal aliases escaped",
);
console.log(
  "Packed consumer OK: ESM, declarations, plans, resources, Platform and separate reactive copies",
);
