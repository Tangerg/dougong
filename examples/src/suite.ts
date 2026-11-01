import { serviceBasics } from "./01-service.js";
import { extensionAndEvent } from "./02-extension-event.js";
import { lifetimeOwnership } from "./03-lifetime.js";
import { reactiveLifetime } from "./04-reactive.js";
import { configurationAndFailure } from "./05-configuration-failure.js";
import { contractsAndGroups } from "./06-contracts-groups.js";
import { diagnostics } from "./07-diagnostics.js";
import { lazyPlatform } from "./08-platform.js";
import { planetScenario } from "./09-planet.js";
import { lynxScenario } from "./10-lynx.js";
import { declarativePlan } from "./11-declarative-plan.js";
import { hotModuleReplacement } from "./12-hot-module-replacement.js";
import type { Example, ExampleResult } from "./example.js";

const examples: ReadonlyArray<Example> = [
  serviceBasics,
  extensionAndEvent,
  lifetimeOwnership,
  reactiveLifetime,
  configurationAndFailure,
  contractsAndGroups,
  diagnostics,
  lazyPlatform,
  planetScenario,
  lynxScenario,
  declarativePlan,
  hotModuleReplacement,
];

export async function runAllExamples(): Promise<ReadonlyArray<ExampleResult>> {
  const results: ExampleResult[] = [];
  for (const example of examples) results.push(await example());
  return Object.freeze(results);
}
