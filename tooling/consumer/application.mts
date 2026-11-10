import {
  createResourceAuthority,
  createHost,
  DougongError,
  definePlugin,
  extensionPoint,
  describePlugin,
  service,
  type ChildLifetime,
  type LifetimeContext,
  type PlanReport,
  type ResolvedValue,
} from "dougong";
import { captureDataArray, ReadonlyMapSnapshot, resolveValue, SerialQueue } from "dougong/advanced";
import { bridge, computed } from "@dougongjs/reactive";
import type * as Reactive from "@dougongjs/reactive";
import { createPlatform, MemoryLoader } from "@dougongjs/platform";
import { verifyObservationBoundary } from "./observation-boundary.mjs";

const resourceAuthority = createResourceAuthority();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const GREETING = service<{ greet(name: string): string }>("consumer/greeting");
const ACTIONS = extensionPoint<() => string>("consumer/actions");
const REMOTE = service<{ value: string }>("consumer/remote");
let owner!: LifetimeContext;
let released = 0;
let setups = 0;
const greeting = definePlugin({
  name: "consumer.greeting",
  provides: { greeting: GREETING },
  setup({ lifetime, contributions, metadata, logger }) {
    assert(
      metadata.installationId === "greeting" && typeof logger.debug === "function",
      "Packed Plugin context omitted its execution metadata or logger",
    );
    contributions.add(ACTIONS, "hello", () => "hello");
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
  description.name === greeting.name && description.configuration.status === "schemaAbsent",
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
const host = createHost({
  resourceAuthority,
  installations: [{ id: "greeting", plugin: greeting }],
});
await host.start();
assert(!(Symbol.asyncDispose in owner), "Plugin root can bypass Engine shutdown");
const actions = host.contributions(ACTIONS);
const ids: readonly string[] = actions.get();
assert(
  Object.isFrozen(ids) && ids.length === 1,
  "Contribution discovery must enumerate frozen IDs",
);
assert(
  (await actions.use(ids[0], (run) => run())).value === "hello",
  "Cannot borrow a listed contribution",
);
const child: ChildLifetime = owner.child("consumer-work");
let childReleases = 0;
const connection = {
  name: "connection",
  [Symbol.dispose]() {
    childReleases++;
  },
};
const receipt = await child.acquire(() => connection);
assert(
  Object.isFrozen(receipt) && receipt.resource === connection,
  "Acquisition delivered a different resource than the owner adopted",
);
await child[Symbol.asyncDispose]();
assert(childReleases === 1, "Acquired resource did not follow its child Lifetime");
assert(
  (await host.use(GREETING, (value) => value.greet("consumer"))).value === "Hello, consumer",
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
  setup({ dependencies }) {
    return { remote: { value: dependencies.greeting.greet("remote") } };
  },
});
const nextRemote = definePlugin({
  name: remote.name,
  provides: { remote: REMOTE },
  setup: () => ({ remote: { value: "replacement" } }),
});
const platform = createPlatform({
  id: "consumer-delivery",
  host,
  apiVersion: "1.0.0",
  loader: new MemoryLoader<string>(
    new Map<string, unknown>([
      ["module", { default: remote }],
      ["next", { default: nextRemote }],
    ]),
  ),
});
const [selected] = await platform.select([
  platform.catalog.add({
    revision: "remote-content-1",
    manifest: { name: remote.name, version: "1.0.0" },
    reference: "module",
  }),
]);
const selection = captureDataArray([selected], "Registrations");
assert(
  selection[0] === selected && Object.isFrozen(selection),
  "Data snapshot changed handle identity",
);
assert(platform.preview(selection).selections.length === 1, "Packed Platform preview differs");
await platform.activate([selected]);
assert(
  (await host.use(REMOTE, (value) => value.value)).value === "Hello, remote",
  "Packed Platform activation did not use the packed core",
);
assert(selected.activeOrigin?.revision === "remote-content-1", "Execution origin did not commit");

assert(platform.registrations()[0] === selected, "Registration enumeration lost selected identity");
// Selection belongs to Platform. An outstanding Core borrow must keep its committed origin and value together.
const next = platform.catalog.add({
  revision: "remote-content-2",
  manifest: { name: remote.name, version: "2.0.0" },
  reference: "next",
});
const held = Promise.withResolvers<void>();
const using = host.use(REMOTE, async (value) => {
  await held.promise;
  return value.value;
});
try {
  assert(
    (await platform.select([next]))[0] === selected,
    "Reselection changed registration identity",
  );
  const [attempt] = await Promise.allSettled([platform.activate([selected])]);
  assert(
    attempt.status === "rejected" &&
      attempt.reason instanceof DougongError &&
      attempt.reason.code === "HOST_BUSY",
    "Platform replaced a borrowed Core generation",
  );
  assert(
    selected.activeOrigin?.revision === "remote-content-1",
    "Rejected activation advanced active origin",
  );
} finally {
  held.resolve();
}
assert((await using).value === "Hello, remote", "Rejected replacement changed a borrowed instance");
await platform.activate([selected]);
const currentOrigin = () => selected.activeOrigin?.revision;
assert(
  currentOrigin() === next.revision &&
    (await host.use(REMOTE, (value) => value.value)).value === "replacement",
  "Committed service and delivery origin diverged",
);
const change = host.change();
assert(!("take" in change), "Internal draft control escaped the Host");
const probe = definePlugin({ name: "consumer.probe", setup() {} });
change.install(probe, { id: "probe", origin: { kind: "fixture", revision: "probe-1" } });
const plan = await host.plan(change);
const report: PlanReport = plan.report;
assert(!("blockers" in report), "An executable Plan exposes a permanent empty blocker list");
assert(report.baseStateRevision === host.diagnostics.get().stateRevision, "Plan baseline differs");
assert(
  report.bindings.before.length === report.bindings.after.length,
  "Unchanged bindings were not projected before and after",
);
assert(
  report.prepareOrder.includes("probe"),
  "Preparation order omitted the affected installation",
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
assert((await new SerialQueue().run(() => 7)).value === 7, "Advanced entrypoint is not executable");
assert(new ReadonlyMapSnapshot([["one", 1]]).get("one") === 1, "Advanced map export differs");
const resolved: ResolvedValue<number> = await resolveValue(Promise.resolve(7));
assert(resolved.value === 7 && Object.isFrozen(resolved), "Advanced result receipt differs");
await platform[Symbol.asyncDispose]();
await host[Symbol.asyncDispose]();
assert(released === 1, "Packed resource protocol failed to release exactly once");
assert(
  !("install" in host) && !("get" in host) && !("dispose" in host) && !("inspect" in host),
  "Retired Host mutation or disposal aliases escaped",
);
await verifyObservationBoundary();
console.log(
  "Packed consumer OK: ESM, declarations, plans, resources, Platform and separate reactive copies",
);
