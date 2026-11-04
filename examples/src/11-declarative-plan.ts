import { asyncDisposeSymbol, createHost, definePlugin, service } from "dougong";
import { MemoryLoader } from "@dougongjs/platform";
import { DeploymentController } from "./deployment-controller.js";
import { exampleResult, expectFailure, type ExampleResult } from "./example.js";

interface Greeter {
  greet(): string;
}
const GREETER = service<Greeter>("examples/declarative-plan/greeter");
const GREETER_NAME = "examples.declarative-plan.greeter";
const LEGACY_NAME = "examples.declarative-plan.legacy";
const TOOL_NAME = "examples.declarative-plan.tool";

export async function declarativePlan(): Promise<ExampleResult> {
  let legacyDisposals = 0;
  let toolStarts = 0;
  const greeter = (message: string) =>
    definePlugin({
      name: GREETER_NAME,
      provides: { greeter: GREETER },
      setup: () => ({ greeter: { greet: () => message } }),
    });
  const legacy = definePlugin({
    name: LEGACY_NAME,
    setup({ lifetime }) {
      lifetime.defer(() => legacyDisposals++);
    },
  });
  const tool = definePlugin({
    name: TOOL_NAME,
    setup() {
      toolStarts++;
    },
  });
  const host = createHost({ name: "declarative-plan-example" });
  await host.start();
  const deployment = new DeploymentController({
    id: "deployment",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader<string>(
      new Map([
        ["greeter-v1", { default: greeter("hello-v1") }],
        ["greeter-v2", { default: greeter("hello-v2") }],
        ["legacy", { default: legacy }],
        ["tool", { default: tool }],
      ]),
    ),
  });
  const artifact = (name: string, version: string, reference: string) =>
    deployment.catalog.add({
      revision: reference,
      manifest: { name, version, activation: ["startup"] },
      reference,
    });
  const original = artifact(GREETER_NAME, "1.0.0", "greeter-v1");
  const replacement = artifact(GREETER_NAME, "2.0.0", "greeter-v2");
  const broken = artifact(GREETER_NAME, "2.0.0", "missing-module");
  const legacyArtifact = artifact(LEGACY_NAME, "1.0.0", "legacy");
  const toolArtifact = artifact(TOOL_NAME, "1.0.0", "tool");
  await deployment.deploy([original, legacyArtifact]);
  const { value: before } = await host.use(GREETER, (greeter) => greeter.greet());
  const failure = await expectFailure("MODULE_LOAD_FAILED", () =>
    deployment.deploy([broken, toolArtifact]),
  );
  const { value: afterFailure } = await host.use(GREETER, (greeter) => greeter.greet());
  const legacyAfterFailure = legacyDisposals;
  await deployment.deploy([replacement, toolArtifact]);
  const { value: afterCommit } = await host.use(GREETER, (greeter) => greeter.greet());
  const legacyAfterCommit = legacyDisposals;
  const deployed = [...deployment.diagnostics.get().registrations.keys()].sort().join(", ");
  await deployment[asyncDisposeSymbol]();
  await host.stop();
  return exampleResult({
    id: "11",
    title: "A desired-state controller compiled into one activation Plan",
    facts: [
      `The initial plan published '${before}'.`,
      `The missing module caused ${failure.code}. The running service remained '${afterFailure}'.`,
      `Failed preparation left the old removal candidate intact: its disposal count stayed ${legacyAfterFailure}.`,
      `One Core Plan added, replaced and removed implementations together, publishing '${afterCommit}' and releasing the legacy Instance ${legacyAfterCommit} time.`,
      `The resulting deployment contains ${deployed}; the tool started ${toolStarts} time.`,
      "Selected Artifact revisions express desired state; activeOrigin alone identifies the committed implementation.",
    ],
  });
}
