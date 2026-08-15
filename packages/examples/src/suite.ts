import { serviceBasics } from "./01-service";
import { extensionAndEvent } from "./02-extension-event";
import { lifetimeOwnership } from "./03-lifetime";
import { reactiveLifetime } from "./04-reactive";
import { configAndFailure } from "./05-config-failure";
import { contractsAndGroups } from "./06-contracts-groups";
import { diagnostics } from "./07-diagnostics";
import { lazyPlatform } from "./08-platform";
import { planetScenario } from "./09-planet";
import { lynxScenario } from "./10-lynx";
import { declarativePlan } from "./11-declarative-plan";
import { hmrModuleGraph } from "./12-hmr-module-graph";
import type { Example, ExampleResult } from "./example";

/** The reading order. Chapters run in sequence and each owns its Application. */
const examples: ReadonlyArray<Example> = [
  // Atoms.
  serviceBasics,
  extensionAndEvent,
  lifetimeOwnership,
  reactiveLifetime,
  // Composition.
  configAndFailure,
  contractsAndGroups,
  diagnostics,
  lazyPlatform,
  // Real host shapes.
  planetScenario,
  lynxScenario,
  declarativePlan,
  hmrModuleGraph,
];

export async function runAllExamples(): Promise<ReadonlyArray<ExampleResult>> {
  const results: ExampleResult[] = [];
  for (const example of examples) results.push(await example());
  return Object.freeze(results);
}
