import {
  createApp,
  createPlatform,
  definePlugin,
  MemoryPluginLoader,
  PermissionSet,
  service,
  type ManagedPlugin,
  type PluginArtifact,
  type PluginPlatform,
} from "dougong";
import { exampleResult, type ExampleResult } from "./example";

interface Greeter {
  greet(): string;
}

interface PlanEntry {
  /** Explicit content identity; the Manifest name remains the only plugin identity. */
  readonly revision: string;
  readonly artifact: PluginArtifact<string>;
}

interface DeploymentRecord {
  readonly revision: string;
  readonly plugin: ManagedPlugin<string>;
}

const GREETER = service<Greeter>("examples/declarative-plan/greeter");
const GREETER_NAME = "examples.declarative-plan.greeter";
const LEGACY_NAME = "examples.declarative-plan.legacy";
const TOOL_NAME = "examples.declarative-plan.tool";

/**
 * A host-owned desired-state controller. It remembers stable Platform handles,
 * but delegates all validation, loading, atomicity and rollback to one
 * canonical Platform ChangeSet.
 */
class PlanDeployment {
  readonly #platform: PluginPlatform<string>;
  #records = new Map<string, DeploymentRecord>();

  constructor(platform: PluginPlatform<string>) {
    this.#platform = platform;
  }

  async apply(plan: ReadonlyArray<PlanEntry>) {
    const desired = indexPlan(plan);
    const change = this.#platform.change();
    const next = new Map<string, DeploymentRecord>();

    for (const [key, current] of this.#records) {
      if (!desired.has(key)) change.remove(current.plugin);
    }

    for (const [name, entry] of desired) {
      const current = this.#records.get(name);
      if (!current) {
        next.set(name, {
          revision: entry.revision,
          plugin: change.register(entry.artifact),
        });
      } else {
        if (current.revision !== entry.revision) {
          change.update(current.plugin, entry.artifact);
        }
        next.set(name, {
          revision: entry.revision,
          plugin: current.plugin,
        });
      }
    }

    await change.commit();
    this.#records = next;
  }
}

function indexPlan(plan: ReadonlyArray<PlanEntry>) {
  const entries = new Map<string, PlanEntry>();
  for (const entry of plan) {
    if (!entry || typeof entry !== "object") throw new TypeError("Plan entry must be an object");
    const name = entry.artifact.manifest.name;
    if (
      typeof entry.revision !== "string" ||
      !entry.revision.trim() ||
      entry.revision !== entry.revision.trim()
    ) {
      throw new TypeError(`Plan revision for '${name}' must be a non-empty, trimmed string`);
    }
    if (entries.has(name)) throw new TypeError(`Duplicate plugin '${name}' in plan`);
    entries.set(name, entry);
  }
  return entries;
}

function artifact(name: string, version: string, reference: string): PluginArtifact<string> {
  return Object.freeze({
    manifest: { name, version, activation: ["startup"] },
    reference,
  });
}

function entry(name: string, revision: string, reference: string, version: string): PlanEntry {
  return Object.freeze({ revision, artifact: artifact(name, version, reference) });
}

/**
 * The last two chapters build what mature plugin frameworks ship as built-in
 * subsystems — a config loader and a hot-reload engine — in about 200 lines
 * each, using only the public API and adding no new primitive. That is the
 * test of whether Core's abstractions are open enough to be composed on.
 */
export async function declarativePlan(): Promise<ExampleResult> {
  let legacyDisposals = 0;
  let toolStarts = 0;
  const greeterV1 = definePlugin({
    name: GREETER_NAME,
    provides: { greeter: GREETER },
    setup: () => ({ greeter: { greet: () => "hello-v1" } }),
  });
  const greeterV2 = definePlugin({
    name: GREETER_NAME,
    provides: { greeter: GREETER },
    setup: () => ({ greeter: { greet: () => "hello-v2" } }),
  });
  const legacy = definePlugin({
    name: LEGACY_NAME,
    setup(ctx) {
      ctx.cleanup(() => legacyDisposals++);
    },
  });
  const tool = definePlugin({
    name: TOOL_NAME,
    setup() {
      toolStarts++;
    },
  });

  const modules = new Map<string, unknown>([
    ["greeter-v1", { default: greeterV1 }],
    ["greeter-v2", { default: greeterV2 }],
    ["legacy", { default: legacy }],
    ["tool", { default: tool }],
  ]);
  const app = createApp({ name: "declarative-plan-example" });
  await app.start();
  const platform = createPlatform({
    container: app,
    apiVersion: "1.0.0",
    permissions: new PermissionSet(),
    loader: new MemoryPluginLoader<string>(modules),
  });
  const deployment = new PlanDeployment(platform);

  await deployment.apply([
    entry(GREETER_NAME, "greeter-content-1", "greeter-v1", "1.0.0"),
    entry(LEGACY_NAME, "legacy-content-1", "legacy", "1.0.0"),
  ]);
  await platform.trigger("startup");
  const before = app.get(GREETER).greet();

  let rejected = false;
  try {
    await deployment.apply([
      entry(GREETER_NAME, "greeter-content-broken", "missing-module", "2.0.0"),
      entry(TOOL_NAME, "tool-content-1", "tool", "1.0.0"),
    ]);
  } catch {
    rejected = true;
  }
  const afterFailure = app.get(GREETER).greet();
  const legacyAfterFailure = legacyDisposals;

  await deployment.apply([
    entry(GREETER_NAME, "greeter-content-2", "greeter-v2", "2.0.0"),
    entry(TOOL_NAME, "tool-content-1", "tool", "1.0.0"),
  ]);
  await platform.trigger("startup");
  const afterCommit = app.get(GREETER).greet();
  const deployed = [...platform.diagnostics.get().plugins.keys()].sort().join(", ");

  await platform.dispose();
  await app.stop();

  return exampleResult({
    id: "11",
    stage: "hosts",
    title: "A desired-state controller compiled into one Platform ChangeSet",
    introduces: ["desired-state", "content-revision", "platform-change-set"],
    facts: [
      `The initial plan published '${before}'.`,
      `The invalid plan was rejected = ${rejected}; the running service remained '${afterFailure}'.`,
      `Rollback restored the whole plan, not just the failing entry: the removal candidate's disposal count stayed ${legacyAfterFailure}.`,
      `The valid plan atomically published '${afterCommit}' and disposed the legacy plugin ${legacyDisposals} time.`,
      `The final plan contains ${deployed}; the newly declared tool started ${toolStarts} time.`,
      "Identity came from the manifest name and change detection from an explicit revision — never guessed from paths or object contents.",
    ],
  });
}
