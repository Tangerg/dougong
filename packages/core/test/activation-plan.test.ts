import { expect, it, vi } from "vitest";
import { Engine } from "../src/engine";
import { GroupNode } from "../src/group";
import { createInstallationDeclaration, InstallationRecord } from "../src/installation";
import { normalizePlugin } from "../src/plugin";
import { InstanceCoordinator } from "../src/instance-coordinator";
import { ContractRegistry } from "../src/contract-registry";
import { InstallationGraph } from "../src/installation-graph";

const port = () => ({
  hostName: "plan",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  report: vi.fn<() => void>(),
});

it("rolls back from the captured declaration and prepared undefined config without registry restoration", async () => {
  const validate = vi.fn<() => { value: undefined }>(() => ({ value: undefined }));
  const started: string[] = [];
  const old = createInstallationDeclaration(
    normalizePlugin({
      name: "plan.plugin",
      config: { "~standard": { version: 1, vendor: "test", validate } },
      setup: () => {
        started.push("old");
      },
    }),
    undefined,
  );
  const record = new InstallationRecord("plan:1", 1, GroupNode.root("plan"), old);
  const engine = new Engine(port());
  const previous = engine.buildPlan(new Map([[record, old]]));
  await engine.start(previous);
  const next = createInstallationDeclaration(
    normalizePlugin({
      name: "plan.plugin",
      setup() {
        throw new Error("next failed");
      },
    }),
    undefined,
  );
  const candidate = engine.buildPlan(new Map([[record, next]]));
  expect(previous.declarationFor(record)).toBe(old);
  expect(candidate.declarationFor(record)).toBe(next);
  const outcome = await engine.transition(candidate, new Set([record]), () => undefined);
  expect(outcome.kind).toBe("rolled-back");
  expect(record.declaration).toBe(old);
  expect(record.instance?.plugin).toBe(old.plugin);
  expect(started).toEqual(["old", "old"]);
  expect(validate).toHaveBeenCalledOnce();
  await engine.stop();
});

it("returns a failed activation outcome for incomplete inputs without running schema or setup", async () => {
  const validate = vi.fn<() => { value: undefined }>(() => ({ value: undefined }));
  const setup = vi.fn<() => void>();
  const record = new InstallationRecord(
    "plan:1",
    1,
    GroupNode.root("plan"),
    createInstallationDeclaration(
      normalizePlugin({
        name: "plan.plugin",
        config: { "~standard": { version: 1, vendor: "test", validate } },
        setup,
      }),
      undefined,
    ),
  );
  const plan = InstallationGraph.build(new Map([[record, record.declaration]]), new Map());
  const coordinator = new InstanceCoordinator(port());
  const contracts = new ContractRegistry().writer(plan.contractKinds);
  const outcome = await coordinator.activate(plan, new Set([record]), new Map(), contracts);
  expect(outcome?.error).toEqual(new Error("Installation 'plan:1' has no prepared config"));
  expect(outcome?.cleanupIncomplete).toBe(false);
  expect(outcome?.cancelled).toBe(false);
  expect(validate).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
  contracts.discard();
});
